#!/usr/bin/env python3
"""Restore encrypted base backup + WAL from synthetic Hawa data into fresh offline volumes.

Only hawa-chaos-postgres-1 is read. Never accepts a production source or restores in place.
Requires the immutable image built from Dockerfile.postgres-pgbackrest. No ports are published.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import secrets
import signal
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = 'hawa-chaos-postgres-1'
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')
TENANT = '00000000-0000-4000-a000-000000000001'
ACTOR = '00000000-0000-4000-b000-000000000001'

class DrillError(RuntimeError): pass

def run(args, *, data=None, timeout=120, check=True):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        # Never include stdin, environment or full command arguments in a failure receipt.
        output=result.stdout.decode(errors='replace')
        # A wrong CBC key can yield a metadata FormatError with binary fragments.
        # Keep the structured warning/error and hints, never parser payloads.
        diagnostic='\n'.join(line for line in output.splitlines()
          if any(level in line for level in ['WARN:', 'ERROR:', 'HINT:']))
        raise DrillError(f'{args[0]} failed ({result.returncode}): {result.stderr.decode(errors="replace")[-800:]} {diagnostic[-2200:]}')
    return result

def text(args, **kwargs): return run(args, **kwargs).stdout.decode().strip()

def key_metadata_refused(error: DrillError) -> bool:
    message=str(error)
    return ('unable to load info file' in message and '/backup/hawa/backup.info' in message
      and any(kind in message for kind in ['[CryptoError]', '[FormatError]']))

def config(passphrase: str) -> str:
    if not re.fullmatch(r'[0-9a-f]{64}', passphrase): raise DrillError('invalid temporary key format')
    template=(ROOT/'infra/backup/pgbackrest.conf.example').read_text()
    return template + f'\nrepo1-cipher-pass={passphrase}\n'

def fingerprint(sql):
    tables=json.loads(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='hawa'"))
    output={}
    for table in tables:
        if not re.fullmatch(r'[a-z_][a-z0-9_]*',table): raise DrillError('unexpected fixture table name')
        output[table]=json.loads(sql(f'''SELECT json_build_object('rows',count(*),
          'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')))
          FROM hawa."{table}" t'''))
    policies=json.loads(sql("SELECT json_agg(row_to_json(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='hawa'"))
    return {'tables':output,'policies':policies}

class Drill:
    def __init__(self,image: str):
        if not IMAGE_ID.fullmatch(image): raise DrillError('supply a locally cached immutable image ID')
        self.image=image
        self.nonce=uuid.uuid4().hex[:16]
        self.prefix='hawa-pitr-'+self.nonce
        self.label='hawa.pitr-drill='+self.nonce
        self.containers=[]
        self.volumes=[]
        self.backup_label=None

    def docker(self,*args,**kwargs): return text(['docker',*args],**kwargs)
    def volume(self,suffix):
        name=self.prefix+'-'+suffix
        self.docker('volume','create','--label',self.label,name)
        self.volumes.append(name)
        return name
    def helper(self,volumes,script,data=None):
        name=self.prefix+'-helper-'+uuid.uuid4().hex[:6]
        return self.docker('run','--rm','-i','--pull=never','--network','none','--label',self.label,
          '--name',name,*volumes,'--entrypoint','sh',self.image,'-ec',script,data=data)
    def config_volume(self,key):
        volume=self.volume('config-'+uuid.uuid4().hex[:6])
        self.helper(['-v',volume+':/etc/pgbackrest'],
          'cat > /etc/pgbackrest/pgbackrest.conf; chown root:postgres /etc/pgbackrest/pgbackrest.conf; chmod 640 /etc/pgbackrest/pgbackrest.conf',config(key).encode())
        return volume
    def start(self,name,pgdata,repo,cfg,*,archiving=False):
        args=['run','-d','--pull=never','--network','none','--label',self.label,'--name',name,
          '--memory','512m','--shm-size','128m','-v',pgdata+':/var/lib/postgresql/data',
          '-v',repo+':/var/lib/pgbackrest'+('' if archiving else ':ro'),'-v',cfg+':/etc/pgbackrest:ro',
          '-e','POSTGRES_USER=hawa_owner','-e','POSTGRES_DB=hawa','-e','POSTGRES_HOST_AUTH_METHOD=trust',
          '-e','PGDATA=/var/lib/postgresql/data/pgdata',self.image,
          'postgres','-c','listen_addresses=','-c','shared_buffers=128MB',
          '-c','fsync=on','-c','synchronous_commit=on','-c','wal_level=replica']
        if archiving: args+=['-c','archive_mode=on','-c','archive_timeout=60s','-c','archive_command=pgbackrest --stanza=hawa archive-push %p']
        else: args+=['-c','archive_mode=off']
        self.docker(*args)
        self.containers.append(name)
    def sql(self,container,query):
        return self.docker('exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','hawa_owner','-d','hawa',data=query.encode())
    def ready(self,container,timeout=75):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            try:
                # A hot standby can answer SQL before reaching the recovery target.
                if self.sql(container,'SELECT NOT pg_is_in_recovery()')=='t': return
            except DrillError: pass
            time.sleep(.5)
        raise DrillError('restored database did not become ready')
    def backrest(self,container,*args): return self.docker('exec','--user','postgres',container,'pgbackrest','--stanza=hawa',*args)
    def restore(self,pgdata,repo,cfg,target):
        if not self.backup_label: raise DrillError('no observed base backup selected')
        self.helper(['-v',pgdata+':/var/lib/postgresql/data'],
          'mkdir -p /var/lib/postgresql/data/pgdata; chown -R postgres:postgres /var/lib/postgresql/data; chmod 700 /var/lib/postgresql/data/pgdata')
        name=self.prefix+'-restore-'+uuid.uuid4().hex[:6]
        return self.docker('run','--rm','--pull=never','--network','none','--label',self.label,
          '--name',name,'--user','postgres','-v',pgdata+':/var/lib/postgresql/data',
          '-v',repo+':/var/lib/pgbackrest:ro','-v',cfg+':/etc/pgbackrest:ro',
          '--entrypoint','pgbackrest',self.image,'--stanza=hawa','--set='+self.backup_label,'--type=time',
          '--target='+target,'--target-action=promote','--archive-mode=off','restore',timeout=180)
    def cleanup(self):
        errors=[]
        # Query the private label even after a Docker command timeout; never touch unnamed resources.
        for kind,listing,remove in [('container',['ps','-aq'],['rm','-f']),('volume',['volume','ls','-q'],['volume','rm'])]:
            try:
                for resource in self.docker(*listing,'--filter','label='+self.label).splitlines():
                    try: self.docker(*remove,resource)
                    except Exception as exc: errors.append(str(exc))
            except Exception as exc: errors.append(str(exc))
        if errors: raise DrillError('cleanup failed for '+self.label+': '+'; '.join(errors))

    def execute(self):
        identity=json.loads(self.docker('inspect',SOURCE))[0]
        if identity['Config']['Labels'].get('com.docker.compose.project')!='hawa-chaos':
            raise DrillError('source is not the isolated candidate')
        image=json.loads(self.docker('image','inspect',self.image))[0]
        if image['Config']['Labels'].get('org.hawa.pgbackrest.version')!='2.59.1':
            raise DrillError('image lacks the qualified pgBackRest version')
        started=datetime.now(timezone.utc).isoformat()
        print('Disposable recovery resources: '+self.label,flush=True)
        with tempfile.TemporaryDirectory(prefix='hawa-pitr-') as directory:
            # This logical transfer seeds synthetic input only. The tested backup below is physical.
            dump=Path(directory)/'fixture.dump'
            with dump.open('wb') as out:
                result=subprocess.run(['docker','exec',SOURCE,'pg_dump','-U','hawa_owner','-Fc','--no-owner','hawa_chaos'],stdout=out,stderr=subprocess.PIPE,timeout=120)
            if result.returncode: raise DrillError('isolated fixture dump failed')
            cfg=self.config_volume(secrets.token_hex(32))
            repo=self.volume('repository'); pgdata=self.volume('source-data')
            self.helper(['-v',repo+':/var/lib/pgbackrest'],'chown postgres:postgres /var/lib/pgbackrest; chmod 750 /var/lib/pgbackrest')
            source=self.prefix+'-source'
            self.start(source,pgdata,repo,cfg,archiving=True); self.ready(source)
            self.sql(source,'CREATE ROLE hawa_app NOLOGIN; CREATE ROLE hawa_app_a NOLOGIN; CREATE ROLE hawa_app_b NOLOGIN; GRANT hawa_app TO hawa_app_a,hawa_app_b;')
            with dump.open('rb') as inp:
                result=subprocess.run(['docker','exec','-i',source,'pg_restore','-U','hawa_owner','-d','hawa','--no-owner','--exit-on-error'],stdin=inp,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
            if result.returncode: raise DrillError('fixture restore failed: '+result.stderr.decode()[-1000:])
            self.backrest(source,'stanza-create'); self.backrest(source,'check')
            self.backrest(source,'--type=full','backup')
            info=json.loads(self.backrest(source,'--output=json','info'))[0]
            if info['cipher']!='aes-256-cbc' or info['status']['code']!=0: raise DrillError('encrypted backup not healthy')
            self.backup_label=info['backup'][-1]['label']
            backup_stop=info['backup'][-1]['timestamp']['stop']
            # pgBackRest stores whole-second backup times. Keep the target outside that
            # precision boundary and restore the exact observed set, never an inferred newest one.
            until=time.monotonic()+10
            while float(self.sql(source,'SELECT extract(epoch FROM clock_timestamp())'))<=backup_stop+1:
                if time.monotonic()>until: raise DrillError('database and backup clocks disagree')
                time.sleep(.1)
            before,after=str(uuid.uuid4()),str(uuid.uuid4())
            def marker(task):
                self.sql(source,f"""BEGIN; INSERT INTO hawa.tasks(id,tenant_id,title,state) VALUES('{task}','{TENANT}','Synthetic PITR business marker','received');
                  INSERT INTO hawa.task_events(tenant_id,task_id,event_type,aggregate_version,actor_type,correlation_id,data)
                  VALUES('{TENANT}','{task}','recovery.drill.marker',1,'system','{task}','{{"synthetic":true}}'); COMMIT;""")
            marker(before)
            ack=time.monotonic()
            target=self.sql(source,'SELECT clock_timestamp()::text')
            marker_wal=self.sql(source,'SELECT pg_walfile_name(pg_current_wal_insert_lsn())')
            expected=fingerprint(lambda q:self.sql(source,q))
            marker(after)
            print('Base backup complete; waiting for configured 60-second WAL archival.',flush=True)
            # Do not force pg_switch_wal: exercise the real archive_timeout configuration.
            end=time.monotonic()+125
            while True:
                archived=self.sql(source,"SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
                if archived>=marker_wal: break
                if time.monotonic()>end: raise DrillError('business marker WAL did not reach the repository')
                time.sleep(1)
            archive_lag=time.monotonic()-ack
            if archive_lag>900: raise DrillError('fixture archive lag exceeded RPO target')
            self.backrest(source,'archive-get',marker_wal,'/tmp/hawa-marker-wal')
            self.docker('stop','--time','20',source)

            restored_data=self.volume('restored-data'); restored=self.prefix+'-restored'
            recovery_start=time.monotonic()
            print('Marker WAL archived; restoring the exact backup to the selected time.',flush=True)
            self.restore(restored_data,repo,cfg,target)
            self.start(restored,restored_data,repo,cfg); self.ready(restored)
            actual=fingerprint(lambda q:self.sql(restored,q))
            if actual!=expected: raise DrillError('restored application rows or RLS policies differ at target')
            present=self.sql(restored,f"SELECT count(*) FROM hawa.tasks WHERE id='{before}'")
            excluded=self.sql(restored,f"SELECT count(*) FROM hawa.tasks WHERE id='{after}'")
            if (present,excluded)!=('1','0'): raise DrillError('PITR marker inclusion/exclusion failed')
            rls_prefix=f"BEGIN; SET LOCAL ROLE hawa_app; SET LOCAL app.user_id='{ACTOR}'; "
            allowed=self.sql(restored,rls_prefix+f"SET LOCAL app.tenant_id='{TENANT}'; SELECT count(*) FROM hawa.tasks; ROLLBACK;")
            denied=self.sql(restored,rls_prefix+f"SET LOCAL app.tenant_id='{uuid.uuid4()}'; SELECT count(*) FROM hawa.tasks; ROLLBACK;")
            if int(allowed)<=0 or denied!='0': raise DrillError('restored RLS scope did not hold')
            duration=time.monotonic()-recovery_start
            if duration>14400: raise DrillError('fixture restore exceeded RTO target')
            print('Promoted restore and application/RLS parity verified; checking failure controls.',flush=True)

            # The same repository, backup and target have now restored successfully.
            # Change only the key, and require metadata decryption/parsing refusal.
            wrong=self.config_volume(secrets.token_hex(32))
            wrong_data=self.volume('wrong-key-data')
            try: self.restore(wrong_data,repo,wrong,target)
            except DrillError as exc:
                if not key_metadata_refused(exc): raise
                wrong_rejected=True
            else: raise DrillError('wrong repository key was accepted')

            broken_repo=self.volume('missing-wal-repository')
            self.helper(['-v',repo+':/original:ro','-v',broken_repo+':/copy'],
              'cp -a /original/. /copy/; chown postgres:postgres /copy')
            # This only deletes from a newly labeled negative-control copy.
            self.helper(['-v',broken_repo+':/copy'],
              f"find /copy/archive/hawa -type f -name '{marker_wal}*' -delete")
            broken_data=self.volume('missing-wal-data'); broken=self.prefix+'-missing-wal'
            self.restore(broken_data,broken_repo,cfg,target)
            self.start(broken,broken_data,broken_repo,cfg)
            deadline=time.monotonic()+45
            while self.docker('inspect','--format','{{.State.Running}}',broken)=='true':
                if time.monotonic()>deadline: raise DrillError('missing WAL did not stop recovery')
                time.sleep(.5)
            # PostgreSQL logs go to stderr in Docker; collect both streams without exposing them.
            raw=run(['docker','logs',broken]); logs=raw.stdout.decode()+raw.stderr.decode()
            if 'recovery ended before configured recovery target was reached' not in logs:
                raise DrillError('missing-WAL failure did not prove target refusal')
            return {'schemaVersion':1,'status':'isolated_pitr_verified','startedAt':started,'finishedAt':datetime.now(timezone.utc).isoformat(),
              'imageId':self.image,'baseImageId':identity['Image'],'postgresVersion':self.docker('exec',restored,'postgres','--version'),
              'pgBackRestVersion':self.docker('exec',restored,'pgbackrest','version'),'sourceKind':'synthetic hawa-chaos logical fixture',
              'backupKind':'encrypted physical base backup plus continuously archived WAL','cipher':info['cipher'],
              'backupLabel':self.backup_label,'backupStopEpoch':backup_stop,'backupCompletedBeforeMarker':True,
              'targetTime':target,'includedTaskId':before,'excludedLaterTaskId':after,'markerWal':marker_wal,
              'archiveTimeoutSeconds':60,'forcedWalSwitchAfterMarker':False,'observedArchiveLagSeconds':round(archive_lag,3),
              'restoreSeconds':round(duration,3),'tableCount':len(expected['tables']),'policyCount':len(expected['policies']),
              'targetDataSha256':hashlib.sha256(json.dumps(expected,sort_keys=True).encode()).hexdigest(),
              'allTableRowsAndPolicyDefinitionsMatch':True,'runtimeRoleRowsVisible':int(allowed),'crossTenantRowsVisible':int(denied),
              'promotedAtTarget':True,
              'wrongKeyRejected':wrong_rejected,'missingWalTargetRejected':True,'network':'none','publishedPorts':False,
              'separateHostProved':False,'offHostDurabilityProved':False,'restateReplayProved':False,'productionChanged':False,
              'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image-id',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    drill=Drill(args.image_id)
    signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(DrillError('drill interrupted')))
    try: receipt=drill.execute()
    finally: drill.cleanup()
    receipt['cleanupVerified']=True
    args.output.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))

if __name__=='__main__': main()
