<#
.SYNOPSIS
    Registra a Tarefa Agendada que sobe o teleyes automaticamente no login.

.DESCRIPTION
    Rode este script UMA VEZ, como Administrador, no desktop de produção.
    Cria a tarefa "teleyes-startup", disparada "At log on" do usuário atual,
    chamando start-teleyes.ps1 (que espera o Docker Desktop ficar pronto
    antes de rodar `docker compose up -d`).

    Por que "At log on" e não "At startup": Docker Desktop é um app por
    usuário, não um serviço do Windows — só sobe quando alguém loga. Uma
    tarefa "At startup" rodaria antes de qualquer sessão existir, e o Docker
    Desktop nem teria começado a iniciar ainda. "At log on" dispara tanto com
    login manual quanto com autologon (se configurado — ver README), então
    cobre os dois casos com o mesmo gatilho.

    NÃO TESTADO DE VERDADE nesta sessão (sem Windows real disponível nesta
    worktree) — os cmdlets usados (Register-ScheduledTask e afins) são
    conferidos contra a documentação da Microsoft, mas revise antes de rodar
    em produção e reporte de volta se algo precisar de ajuste.

.PARAMETER RepoPath
    Raiz do repositório. Padrão: dois níveis acima deste script.
#>

#Requires -RunAsAdministrator

param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
    [string]$TaskName = "teleyes-startup"
)

$scriptPath = Join-Path $PSScriptRoot "start-teleyes.ps1"
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -RepoPath `"$RepoPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Tarefa '$TaskName' registrada pra $currentUser (dispara no próximo login)."
Write-Host ""
Write-Host "Testar agora sem reiniciar:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Get-Content `"$RepoPath\data\startup.log`" -Tail 20 -Wait"
Write-Host ""
Write-Host "Conferir que ficou registrada:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName"
