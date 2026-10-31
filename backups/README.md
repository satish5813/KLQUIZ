# Database backup

`klquiz-backup.db` is a snapshot of the question bank, exam patterns (with the official syllabus) and tests.

It deliberately contains **no** admin password hashes, session pass keys, or candidates' personal
data and answers. Full backups including students and results are kept offline only.

## Restore

1. Stop the server.
2. Copy `backups/klquiz-backup.db` to `data/klquiz.db` (create the `data` folder if needed;
   delete any old `data/klquiz.db-wal` and `data/klquiz.db-shm`).
3. Make sure `.env` has `ADMIN_USER` and `ADMIN_PASSWORD` — the admin account is recreated from them on start.
4. `npm start`, then generate a new pass key for each test before going live.

## Refresh this snapshot

```bash
node scripts/backup-db.js
```
