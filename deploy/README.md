# Running the servers as services

`amr-ota.service` runs `ota_server/` (port 7000) and `amr-dlms.service` runs
`dlms_server/` (ports 7001 and 7002), both as the `amr` user, restarted
automatically if they stop.

## First install

```bash
cd /opt/client
cp ota_server/.env.example ota_server/.env      # set MASTER_SECRET, ADMIN_TOKEN
cp dlms_server/.env.example dlms_server/.env    # same MASTER_SECRET, VIEW_PASSWORD
nano ota_server/.env dlms_server/.env
sudo bash deploy/install-services.sh
```

The script creates the `amr` user, installs dependencies if missing, writes both units
to `/etc/systemd/system/` with this folder and your `node` path, then enables and starts
them. Node.js must be installed system-wide (not with nvm under `/root`).

Then, once: `cd ota_server && sudo -u amr npm run user:add -- admin --role admin`.

## After a git pull

```bash
cd /opt/client && git pull
(cd ota_server && npm install --omit=dev) && (cd dlms_server && npm install --omit=dev)
sudo systemctl restart amr-ota amr-dlms
```

## Everyday commands

| Task | Command |
|---|---|
| Status | `systemctl status amr-ota amr-dlms` |
| Live log | `journalctl -u amr-ota -f` / `journalctl -u amr-dlms -f` |
| Restart | `sudo systemctl restart amr-ota amr-dlms` |
| Stop | `sudo systemctl stop amr-ota amr-dlms` |
| Check | `curl http://localhost:7000/health` and `cd dlms_server && npm run check` |
