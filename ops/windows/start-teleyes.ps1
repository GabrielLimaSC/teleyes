<#
.SYNOPSIS
    Aguarda o Docker Desktop ficar pronto e sobe o stack de produção do teleyes.

.DESCRIPTION
    Chamado pela Tarefa Agendada registrada por register-teleyes-task.ps1, no
    logon do usuário configurado. Docker Desktop já deve estar configurado pra
    iniciar automaticamente no login (Settings > General > "Start Docker
    Desktop when you log in", ver README) — este script não inicia o Docker
    Desktop sozinho, só espera o daemon dele responder antes de rodar o
    compose, já que mesmo com "start on login" o daemon leva um tempo real
    pra ficar pronto depois do Docker Desktop abrir.

    NÃO TESTADO DE VERDADE nesta sessão — escrito e revisado numa worktree
    Mac, sem Windows real disponível. Sintaxe conferida contra a documentação
    do PowerShell/Docker, mas a execução real (e portanto o `done_when` de
    S5-06: reboot real recupera sozinho) fica pendente do teste do Gabriel no
    desktop de casa.

.PARAMETER RepoPath
    Raiz do repositório (onde está docker-compose.prod.yml). Padrão: dois
    níveis acima deste script (ops/windows/../..).

.PARAMETER DockerReadyTimeoutSeconds
    Quanto esperar o `docker info` responder antes de desistir.
#>

param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
    [int]$DockerReadyTimeoutSeconds = 180,
    [int]$PollIntervalSeconds = 5
)

$ErrorActionPreference = "Stop"

$dataDir = Join-Path $RepoPath "data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}
$logPath = Join-Path $dataDir "startup.log"

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format o)  $Message"
    Write-Output $line
    Add-Content -Path $logPath -Value $line
}

Write-Log "teleyes: iniciando, aguardando Docker Desktop ficar pronto (timeout ${DockerReadyTimeoutSeconds}s)..."

$deadline = (Get-Date).AddSeconds($DockerReadyTimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds $PollIntervalSeconds
}

if (-not $ready) {
    Write-Log "teleyes: Docker não ficou pronto a tempo — abortando. Confira se o Docker Desktop está configurado pra iniciar no login (Settings > General > Start Docker Desktop when you log in) e se ele conseguiu subir sozinho."
    exit 1
}

Write-Log "teleyes: Docker pronto, subindo docker compose..."
Push-Location $RepoPath
try {
    docker compose -f docker-compose.prod.yml up -d 2>&1 | ForEach-Object { Write-Log "$_" }
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($exitCode -ne 0) {
    Write-Log "teleyes: docker compose up terminou com erro (código $exitCode)."
    exit $exitCode
}

Write-Log "teleyes: stack no ar."
