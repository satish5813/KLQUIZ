#!/bin/sh
# klquiz-backup: consistent SQLite snapshot (VACUUM INTO, safe while the portal runs), KLB1 encrypt to /backups,
# verify, prune old files. Runs in the app image (node + node:sqlite).
set -eu
node /app/scripts/backup-full.js /work >/work/snapshot.log
cat /work/snapshot.log
snap=$(ls -1 /work/klquiz-full-*.db | head -1)
ts=$(date -u -d "@$(( $(date +%s) + 19800 ))" +%Y%m%d_%H%M)   # IST (the image has no time-zone data)
out="/backups/klquiz-prod_${ts}.db.enc"
node /scripts/backup-encrypt.js encrypt "$snap" "$out.part"
node /scripts/backup-encrypt.js verify "$out.part"
mv "$out.part" "$out"
find /backups -name 'klquiz-prod_*.db.enc' -mtime +"${KEEP_DAYS:-14}" -delete
echo "BACKUP OK $(basename "$out") $(du -h "$out" | cut -f1); kept: $(ls /backups | grep -c '^klquiz-prod_')"
