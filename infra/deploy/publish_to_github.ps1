param(
    [string]$RemoteUrl = "https://github.com/maknud7/blindleiadarts.git"
)

$ErrorActionPreference = "Stop"

function Require-Git {
    $git = Get-Command git -ErrorAction SilentlyContinue

    if (-not $git) {
        throw "Git is not installed or not available in PATH."
    }

    return $git.Source
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$gitExe = Require-Git

Push-Location $root

try {
    if (-not (Test-Path ".git")) {
        & $gitExe init
    }

    & $gitExe add .
    & $gitExe commit -m "Initial project baseline with GitHub deploy workflows" 2>$null

    $currentBranch = (& $gitExe branch --show-current).Trim()
    if ([string]::IsNullOrWhiteSpace($currentBranch)) {
        & $gitExe branch -M main
    } elseif ($currentBranch -ne "main") {
        & $gitExe branch -M main
    }

    $remoteExists = (& $gitExe remote) -contains "origin"
    if ($remoteExists) {
        & $gitExe remote set-url origin $RemoteUrl
    } else {
        & $gitExe remote add origin $RemoteUrl
    }

    & $gitExe push -u origin main

    $hasDevelop = (& $gitExe branch --list develop).Length -gt 0
    if (-not $hasDevelop) {
        & $gitExe checkout -b develop
    } else {
        & $gitExe checkout develop
    }

    & $gitExe push -u origin develop
    & $gitExe checkout main
}
finally {
    Pop-Location
}

Write-Host "Repository published to $RemoteUrl with main and develop branches."
