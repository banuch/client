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
(cd ota_server && npm ci --omit=dev) && (cd dlms_server && npm ci --omit=dev)
sudo systemctl restart amr-ota amr-dlms
```

## Deploy from a Windows PC

`tools\deploy.ps1` ships the branch you are on in one step: it runs the tests of
the servers that changed, pushes, opens a pull request (or uses the open one),
asks once, merges it into `master`, then on the server pulls `master`, runs
`npm ci` where `package.json` changed (it never rewrites `package-lock.json`,
so the server checkout stays clean), restarts only the services whose
code changed (`shared/` and `deploy/` restart both) and checks that both answer.

```powershell
.\tools\deploy.ps1                  # from the branch to ship
.\tools\deploy.ps1 -Title "Fix X"   # pull request title (default: from the commits)
.\tools\deploy.ps1 -Yes             # no question before merging
.\tools\deploy.ps1 -ServerOnly      # only update the server from master
```

It stops without changing anything when the tests fail, the branch has
uncommitted changes, or the server checkout is not on `master` or has local
changes. If a service does not answer after the restart it prints the last log
lines.

Once, on the PC:

1. GitHub CLI: `winget install GitHub.cli`, open a new terminal, then
   `gh auth login` (GitHub.com, HTTPS, log in with a browser).
2. Key login to the server. `~/.ssh/config` names it `vultr-vm`; copy the
   public key there (asks for the server password one last time):

   ```powershell
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh vultr-vm "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ssh -o BatchMode=yes vultr-vm echo ok    # must print ok without a password
   ```

   If the key has a passphrase, start the agent once so the script can use it:
   `Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent; ssh-add`.
3. If Windows blocks scripts, allow your own: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
   (or run `powershell -ExecutionPolicy Bypass -File tools\deploy.ps1`).

## Everyday commands

| Task | Command |
|---|---|
| Status | `systemctl status amr-ota amr-dlms` |
| Live log | `journalctl -u amr-ota -f` / `journalctl -u amr-dlms -f` |
| Restart | `sudo systemctl restart amr-ota amr-dlms` |
| Stop | `sudo systemctl stop amr-ota amr-dlms` |
| Check | `curl http://localhost:7000/health` and `cd dlms_server && npm run check` |
