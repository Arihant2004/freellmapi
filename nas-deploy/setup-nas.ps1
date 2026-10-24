# One-time NAS switch-over to the private auto-deploy image.
#
# Logs the NAS in to ghcr.io, then updates the EXISTING freellmapi compose
# project in place: backs up its compose file and .env, installs
# nas-deploy/docker-compose.yml, adds GHCR_USER / GHCR_TOKEN to the NAS .env
# (other values, like ENCRYPTION_KEY, are left untouched), and restarts on
# ghcr.io/arihant2004/freellmapi:main. Same compose project name, so the
# data volume (keys, settings, history) is kept.
#
# Needs SSH enabled on the NAS (DSM: Control Panel > Terminal & SNMP) and a
# DSM administrator account. Asks for the DSM password twice: SSH, then sudo.
#
#   powershell -ExecutionPolicy Bypass -File "D:\DESKTOP\free llm api\freellmapi\nas-deploy\setup-nas.ps1"
#
# -DryRun prints the script that would run on the NAS (token redacted) and
# connects to nothing.
param(
  [string]$NasIp = '192.168.0.167',
  [int]$NasPort = 2222,
  [string]$NasUser,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$envLines = Get-Content (Join-Path $here '.env')
$ghcrUser = (($envLines | Where-Object { $_ -like 'GHCR_USER=*' }) -replace '^GHCR_USER=', '').Trim()
$ghcrToken = (($envLines | Where-Object { $_ -like 'GHCR_TOKEN=*' }) -replace '^GHCR_TOKEN=', '').Trim()
if (-not $ghcrUser -or -not $ghcrToken) { throw 'GHCR_USER / GHCR_TOKEN missing from nas-deploy\.env' }
$compose = ([IO.File]::ReadAllText((Join-Path $here 'docker-compose.yml')) -replace "`r`n", "`n").TrimEnd("`n")

# Runs on the NAS. Placeholders are filled in below; the compose file goes in
# through a quoted heredoc so its ${...} references stay literal.
$remoteScript = @'
set -e
umask 077
D=/usr/local/bin/docker
IMAGE=ghcr.io/arihant2004/freellmapi:main
GHCR_USER='__GHCR_USER__'
GHCR_TOKEN='__GHCR_TOKEN__'

echo '==> sudo: enter your DSM password'
sudo -v

echo '==> Logging the NAS in to ghcr.io'
printf '%s' "$GHCR_TOKEN" | sudo $D login ghcr.io -u "$GHCR_USER" --password-stdin

echo '==> Finding the existing freellmapi project'
label() { sudo $D inspect freellmapi --format "{{ index .Config.Labels \"$1\" }}"; }
PROJECT=$(label com.docker.compose.project)
WORKDIR=$(label com.docker.compose.project.working_dir)
CONFIG=$(label com.docker.compose.project.config_files)
CONFIG=${CONFIG%%,*}
ENVFILE="$(dirname "$CONFIG")/.env"
echo "    project: $PROJECT"
echo "    compose: $CONFIG"
if [ -z "$PROJECT" ] || ! sudo test -f "$CONFIG" || ! sudo test -f "$ENVFILE"; then
  echo 'Could not find the compose project (or its .env) behind the freellmapi container. Nothing was changed.'
  exit 1
fi

echo '==> Pulling your private image (checks the login before anything changes)'
sudo $D pull "$IMAGE"

echo '==> Backing up the compose file and .env'
STAMP=$(date +%Y%m%d-%H%M%S)
sudo cp "$CONFIG" "$CONFIG.bak-$STAMP"
sudo cp "$ENVFILE" "$ENVFILE.bak-$STAMP"

echo '==> Installing the new compose file'
sudo tee "$CONFIG" >/dev/null <<'COMPOSE_EOF'
__COMPOSE__
COMPOSE_EOF

if sudo grep -q '^GHCR_TOKEN=' "$ENVFILE"; then
  echo '    .env already has GHCR_TOKEN; left as is'
else
  printf '\n# Login for the private image (read:packages token)\nGHCR_USER=%s\nGHCR_TOKEN=%s\n' "$GHCR_USER" "$GHCR_TOKEN" | sudo tee -a "$ENVFILE" >/dev/null
  echo '    added GHCR_USER / GHCR_TOKEN to .env'
fi

if sudo $D compose version >/dev/null 2>&1; then DC="sudo $D compose"; else DC="sudo /usr/local/bin/docker-compose"; fi
echo '==> Restarting freellmapi + watchtower (data volume is kept)'
cd "$WORKDIR"
if ! $DC -p "$PROJECT" -f "$CONFIG" up -d; then
  echo "Restart FAILED. To roll back: sudo cp '$CONFIG.bak-$STAMP' '$CONFIG'; sudo cp '$ENVFILE.bak-$STAMP' '$ENVFILE'; then start the project in Container Manager."
  exit 1
fi
sleep 5
sudo $D ps --filter "label=com.docker.compose.project=$PROJECT" --format '    {{.Names}}  {{.Image}}  {{.Status}}'
echo "==> Done. Backups: $CONFIG.bak-$STAMP and $ENVFILE.bak-$STAMP"
'@

$remoteScript = $remoteScript -replace "`r`n", "`n"
$remoteScript = $remoteScript.Replace('__GHCR_USER__', $ghcrUser).Replace('__COMPOSE__', $compose)

if ($DryRun) {
  $remoteScript.Replace('__GHCR_TOKEN__', 'REDACTED')
  return
}

if (-not (Test-NetConnection -ComputerName $NasIp -Port $NasPort -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  Write-Host "SSH is not reachable on $NasIp port $NasPort. In DSM: Control Panel > Terminal & SNMP > tick 'Enable SSH service' (port $NasPort) > Apply, then run this again." -ForegroundColor Yellow
  exit 1
}
if (-not $NasUser) { $NasUser = Read-Host 'DSM admin username' }

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript.Replace('__GHCR_TOKEN__', $ghcrToken)))
# The script travels as base64 (no quoting to survive), lands in a 0600 temp
# file because it holds the token, and is deleted whether or not it succeeds.
$remote = 'umask 077; echo ' + $b64 + ' | base64 -d > /tmp/freellmapi-setup.sh; bash /tmp/freellmapi-setup.sh; rc=$?; rm -f /tmp/freellmapi-setup.sh; exit $rc'

ssh -t -p $NasPort "$NasUser@$NasIp" $remote
if ($LASTEXITCODE -eq 0) {
  Write-Host "`nNAS is on your private image. Open http://${NasIp}:3001 and check your keys and settings are there." -ForegroundColor Green
} else {
  Write-Host "`nSetup did not finish (exit $LASTEXITCODE). Read the messages above; nothing is changed unless it got past 'Backing up'." -ForegroundColor Yellow
}
