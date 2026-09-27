import subprocess,json,tempfile,ipaddress,time,uuid
from pathlib import Path
root=Path('/Users/hawzhin/Hawdesign');old=(root/'infra/docker/nginx.conf').read_text()
new=old.replace('    # Upstream Services (Internal Docker Core Network)\n','    # Docker replaces service addresses during deployments. Refresh DNS without a proxy restart.\n    resolver 127.0.0.11 valid=5s ipv6=off;\n    resolver_timeout 2s;\n\n    # Upstream Services (Internal Docker Core Network)\n').replace('upstream core_api {\n        server core:3001;','upstream core_api {\n        zone core_api 64k;\n        server core:3001 resolve;').replace('upstream desk_pwa {\n        server desk:80;','upstream desk_pwa {\n        zone desk_pwa 64k;\n        server desk:80 resolve;')
Path('/private/tmp/hawa-nginx-dynamic.conf').write_text(new)
prefix='hawa-dns-drill-'+uuid.uuid4().hex[:8];network=prefix;created=[]
def run(args,check=True):return subprocess.run(args,capture_output=True,text=True,check=check,timeout=30)
def docker(*args,check=True):return run(['docker',*args],check)
report={'scope':'Disposable internal Docker network only; existing nginx image; real changed backend IP; no production service changed.','checks':[]}
def check(name,ok,detail=None):
 report['checks'].append({'name':name,'ok':ok,'detail':detail})
 if not ok:raise RuntimeError(name)
def response(name,path='/v1/health'):
 p=docker('exec',name,'wget','-qO-','-T','2','http://127.0.0.1'+path,check=False)
 try:return json.loads(p.stdout).get('instance')
 except Exception:return None
try:
 image=json.loads(docker('inspect','hawa-production-nginx-1').stdout)[0]['Image']
 report['imageId']=image;docker('network','create','--internal',network)
 subnet=json.loads(docker('network','inspect',network).stdout)[0]['IPAM']['Config'][0]['Subnet'];net=ipaddress.ip_network(subnet)
 with tempfile.TemporaryDirectory(prefix=prefix,dir='/private/tmp') as directory:
  p=Path(directory);(p/'old.conf').write_text(old);(p/'new.conf').write_text(new)
  def backend(label,offset):
   conf=p/(label+'.conf');conf.write_text('events {}\nhttp {server {listen 80;listen 3001;location / {default_type application/json;return 200 \'{"instance":"'+label+'"}\';}}}\n')
   name=prefix+'-'+label;created.append(name)
   docker('run','-d','--name',name,'--network',network,'--ip',str(net.network_address+offset),'--network-alias','core','--network-alias','desk','-v',str(conf)+':/etc/nginx/nginx.conf:ro',image)
   return name
  a=backend('before',100);proxies={}
  for label in ['old','new']:
   name=prefix+'-'+label;created.append(name);proxies[label]=name
   docker('run','-d','--name',name,'--network',network,'-v',str(p/(label+'.conf'))+':/etc/nginx/nginx.conf:ro',image)
  deadline=time.monotonic()+20
  while time.monotonic()<deadline and any(response(n)!='before' for n in proxies.values()):time.sleep(.3)
  for label,name in proxies.items():check(label+' routes to original Core',response(name)=='before');check(label+' routes to original Desk',response(name,'/')=='before')
  started=json.loads(docker('inspect',proxies['new']).stdout)[0]['State']['StartedAt']
  docker('rm','-f',a);b=backend('after',101)
  deadline=time.monotonic()+20
  while time.monotonic()<deadline and response(proxies['new'])!='after':time.sleep(.5)
  check('static configuration reproduces stale-address failure',response(proxies['old']) is None)
  check('dynamic configuration recovers Core at changed address',response(proxies['new'])=='after')
  check('dynamic configuration recovers Desk at changed address',response(proxies['new'],'/')=='after')
  check('proxy process was not restarted',json.loads(docker('inspect',proxies['new']).stdout)[0]['State']['StartedAt']==started)
finally:
 for name in reversed(created):docker('rm','-f',name,check=False)
 docker('network','rm',network,check=False)
 Path('/private/tmp/hawa-nginx-dns-drill.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report))
