<#
.SYNOPSIS
    Impede o Windows de suspender/hibernar/desligar a tela enquanto ligado na tomada.

.DESCRIPTION
    Equivalente via `powercfg` ao que Configurações > Sistema > Energia e
    bateria > Telas e suspensão faria manualmente: monitor, suspensão e
    hibernação nunca disparam enquanto o desktop está na tomada (timeout 0 =
    desativado). Não mexe no comportamento na bateria — sem efeito relevante
    num desktop fixo, deixado como está por segurança caso isto rode numa
    máquina com bateria eventualmente.

    NÃO TESTADO DE VERDADE nesta sessão — sem Windows real disponível nesta
    worktree; comandos conferidos contra a documentação da Microsoft
    (`powercfg /?`), não executados de verdade.
#>

#Requires -RunAsAdministrator

powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Write-Host "Configurado: monitor, suspensão e hibernação nunca disparam com o desktop na tomada."
Write-Host "Isso não muda o comportamento na bateria (sem efeito relevante num desktop fixo)."
Write-Host ""
Write-Host "Conferir:"
Write-Host "  powercfg /query SCHEME_CURRENT SUB_VIDEO"
Write-Host "  powercfg /query SCHEME_CURRENT SUB_SLEEP"
