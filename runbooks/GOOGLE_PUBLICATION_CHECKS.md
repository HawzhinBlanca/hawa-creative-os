# Google publication checks

Requirements: FR-047/048/049/050/064, NFR-006. ADR-107, migration 060.

Operations → Google publication checks reads saved observations. Reloading this
panel does not contact Google. Core schedules inspections hourly by publication;
new unfinished publications wait 15 minutes. `HAWA_PUBLICATION_INSPECTIONS=off`
disables scheduling in that Core instance. All instances must be disabled to stop
the deployment's schedule. PostgreSQL serializes claims; a two-minute expired
lease is recorded as interrupted before retry, with at most three attempts per hour.

The comparison uses the original publication destination, reserved file identities,
file hashes and full bound Sheet row. It reads exact files, folder, paged permissions,
scoped duplicates and stable Sheet metadata. Provider calls are bounded and read-only.
Missing objects/access, checksums, original inputs or permission policy stay unverified.
Permission fingerprints can reveal later changes; the first read does not approve access.
The observation interval is not an atomic snapshot across Google resources.

## Resolve a finding

1. Open the affected resource from its finding. Check the task's approved revision,
   original export and configured archive identity before changing external content.
2. For inaccessible resources, restore the publishing identity's authorized access;
   an unreadable object is not proof of deletion. Have the responsible administrator
   confirm sharing policy. There is no automatic permission repair.
3. For changed files, duplicate identities or changed reporting rows, preserve the
   inspection and investigate who changed what. Use the existing task's archive/Sheet
   recheck only when its publication is pending and the conflict has been resolved.
   Do not create a second publication to hide a conflict or overwrite approved content.
4. Historical publications without original inputs require supervised reconstruction
   from actual records; current Client DNA cannot establish their original destination.
5. Reload after the next scheduled check. Stale observations (two hours) are labelled;
   a failed read clears previously displayed success. All findings are expandable.

This panel flags discrepancies. It never changes permissions, repairs files/rows,
marks a publication complete, approves a design or sends a message. Permission policy
approval and historical migration remain separate, unfinished capabilities.
