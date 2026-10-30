<#
.SYNOPSIS
  Ship the current branch: test, push, open a pull request, merge it into
  master, then update the server (git pull, npm install when needed, restart
  the services whose code changed) and check that they answer.

.DESCRIPTION
  Run from anywhere inside the repository, on the branch you want to ship:

    .\tools\deploy.ps1                       # asks once before merging
    .\tools\deploy.ps1 -Yes                  # no question
    .\tools\deploy.ps1 -Title "Fix X"        # pull request title (default: from the commits)
    .\tools\deploy.ps1 -ServerOnly           # only update the server from master
    .\tools\deploy.ps1 -SkipTests

  Needs, once (see deploy/README.md, "Deploy from a Windows PC"):
    - GitHub CLI signed in:   winget install GitHub.cli ; gh auth login
    - SSH key login to the server under the name in -Server (~/.ssh/config).

  The server must be on master with no local changes; the script stops
  otherwise and changes nothing there.
#>
[CmdletBinding()]
param(
  [string]$Server = 'vultr-vm',
  [string]$RepoPath = '/opt/client',
  [string]$Base = 'master',
  [string]$Title = '',
  [string]$Body = '',
  [switch]$Yes,
  [switch]$SkipTests,
  [switch]$ServerOnly
)

# Native commands are checked through $LASTEXITCODE; 'Stop' would also stop on
# anything they write to stderr in Windows PowerShell 5.1.
$ErrorActionPreference = 'Continue'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`nSTOPPED: $text" -ForegroundColor Red; exit 1 }

# Runs a native command; stops the script when it fails.
function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

function Need([string]$exe, [string]$hint) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Fail "$exe not found. $hint" }
}

# ---------------------------------------------------------------- checks
Need git 'Install Git for Windows.'
Need ssh 'Enable the Windows OpenSSH client (Settings > Apps > Optional features).'

$root = (git rev-parse --show-toplevel 2>$null)
if (-not $root) { Fail 'Run this inside the client repository.' }
Set-Location $root

Step "Checking SSH login to $Server"
& ssh -o BatchMode=yes -o ConnectTimeout=10 $Server "test -d $RepoPath/.git"
if ($LASTEXITCODE -ne 0) {
  Fail "Cannot log in to $Server with an SSH key, or $RepoPath is not a git checkout there. See deploy/README.md, 'Deploy from a Windows PC'."
}

if (-not $ServerOnly) {
  Need gh 'Install it with: winget install GitHub.cli   then: gh auth login'
  & gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'GitHub CLI is not signed in. Run: gh auth login' }

  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -eq $Base -or $branch -eq 'HEAD') { Fail "You are on '$branch'. Switch to the branch you want to ship." }
  if (git status --porcelain) { Fail 'There are uncommitted changes. Commit or stash them first.' }

  Run git @('fetch', '--quiet', 'origin')
  $ahead = (git rev-list --count "origin/$Base..HEAD").Trim()
  if ($ahead -eq '0') { Fail "Branch '$branch' has no commits that are not already on $Base." }
  $changed = git diff --name-only "origin/$Base...HEAD"

  # ------------------------------------------------------------ tests
  if (-not $SkipTests) {
    foreach ($dir in 'dlms_server', 'ota_server') {
      if (-not ($changed | Where-Object { $_ -like "$dir/*" -or $_ -like 'shared/*' })) { continue }
      if (-not (Test-Path "$dir/node_modules")) {
        Write-Host "   $dir changed but has no node_modules here; its tests are skipped (npm ci --ignore-scripts in $dir to run them)." -ForegroundColor Yellow
        continue
      }
      Step "Testing $dir"
      Push-Location $dir
      & npm test
      $code = $LASTEXITCODE
      Pop-Location
      if ($code -ne 0) { Fail "$dir tests failed. Nothing was pushed or merged." }
    }
  }

  # ------------------------------------------------------------ pull request
  Step "Pushing $branch"
  Run git @('push', '--quiet', '-u', 'origin', $branch)

  $pr = $null
  $json = & gh pr list --head $branch --base $Base --state open --json 'number,url,title' 2>$null
  if ($LASTEXITCODE -eq 0 -and $json) { $pr = ($json | ConvertFrom-Json) | Select-Object -First 1 }
  if ($pr) {
    Write-Host "   Using open pull request #$($pr.number): $($pr.title)"
  } else {
    Step 'Opening the pull request'
    $createArgs = @('pr', 'create', '--base', $Base, '--head', $branch)
    if ($Title) { $createArgs += @('--title', $Title, '--body', $Body) } else { $createArgs += '--fill' }
    Run gh $createArgs
    $pr = (& gh pr view $branch --json 'number,url,title') | ConvertFrom-Json
  }
  Write-Host "   $($pr.url)"

  Write-Host "`nCommits going to ${Base}:" -ForegroundColor White
  git log --oneline "origin/$Base..HEAD"
  if (-not $Yes) {
    $answer = Read-Host "`nMerge #$($pr.number) into $Base and deploy to ${Server}? [y/N]"
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Not merged. The pull request stays open.'; exit 0 }
  }

  Step "Merging #$($pr.number)"
  Run gh @('pr', 'merge', "$($pr.number)", '--merge', '--delete-branch')
  Run git @('checkout', '--quiet', $Base)
  Run git @('pull', '--quiet', '--ff-only', 'origin', $Base)
}

# ---------------------------------------------------------------- server
# Sent base64-encoded so Windows line endings and quoting cannot break it.
$remote = @'
set -euo pipefail
cd "__REPO__"
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "__BASE__" ]; then echo "Server is on '$branch', not __BASE__; nothing changed." >&2; exit 2; fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "Server has local changes; nothing changed:" >&2; git status --short >&2; exit 2; fi
before=$(git rev-parse HEAD)
git pull --quiet --ff-only origin __BASE__
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then echo "Server already up to date at $(git log --oneline -1)"; changed=""; else
  echo "Updated: $(git log --oneline -1)"
  changed=$(git diff --name-only "$before" "$after")
fi

restart=()
for pair in "ota_server:amr-ota" "dlms_server:amr-dlms"; do
  dir=${pair%%:*}; unit=${pair##*:}
  if grep -qE "^$dir/package(-lock)?\.json$" <<< "$changed"; then
    echo "Installing $dir dependencies"
    # npm ci installs exactly the lock file and never rewrites it, so the
    # checkout stays clean for the next pull.
    (cd "$dir" && npm ci --omit=dev --no-audit --no-fund --silent)
  fi
  if grep -qE "^($dir/|shared/|deploy/)" <<< "$changed"; then restart+=("$unit"); fi
done
if grep -qE "^deploy/.*\.service$" <<< "$changed"; then echo "Note: a service file changed; run: sudo bash deploy/install-services.sh" >&2; fi

if [ ${#restart[@]} -eq 0 ]; then
  echo "No server code changed; nothing restarted."
else
  echo "Restarting ${restart[*]}"
  systemctl restart "${restart[@]}"
  sleep 3
fi

ok=1
for unit in amr-ota amr-dlms; do
  state=$(systemctl is-active "$unit" || true)
  echo "$unit: $state"
  [ "$state" = "active" ] || ok=0
done
port() { { grep -E "^$2=" "$1/.env" 2>/dev/null || true; } | tail -1 | cut -d= -f2 | tr -d '"\r '; }
ota=$(port ota_server PORT); dlms=$(port dlms_server HTTP_PORT)
curl -fsS -m 5 "http://127.0.0.1:${ota:-7000}/health" >/dev/null && echo "OTA server answers on ${ota:-7000}" || { echo "OTA server does not answer on ${ota:-7000}" >&2; ok=0; }
curl -fsS -m 5 "http://127.0.0.1:${dlms:-7002}/api/health" >/dev/null && echo "Data server answers on ${dlms:-7002}" || { echo "Data server does not answer on ${dlms:-7002}" >&2; ok=0; }
[ $ok -eq 1 ] || { echo "Last log lines:" >&2; journalctl -u amr-ota -u amr-dlms -n 20 --no-pager >&2; exit 3; }
'@
$remote = $remote.Replace('__REPO__', $RepoPath).Replace('__BASE__', $Base).Replace("`r", '')
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))

Step "Updating $Server"
& ssh -o BatchMode=yes $Server "echo $encoded | base64 -d | bash"
switch ($LASTEXITCODE) {
  0 { Write-Host "`nDone. Reload the dashboard with Ctrl+Shift+R." -ForegroundColor Green }
  2 { Fail "The server checkout needs attention (see above). The merge on GitHub is done; run '.\tools\deploy.ps1 -ServerOnly' after fixing it." }
  3 { Fail 'A service is not running or not answering after the restart (log lines above).' }
  default { Fail "Updating the server failed (exit $LASTEXITCODE)." }
}
