$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Setup = Join-Path $Root "setup\setup.py"

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $Setup @args
    exit $LASTEXITCODE
}
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python $Setup @args
    exit $LASTEXITCODE
}
Write-Error "ccRemote setup requires Python 3.10 or newer."
