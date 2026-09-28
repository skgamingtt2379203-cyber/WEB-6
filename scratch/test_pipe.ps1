$found = $false
for ($i = 0; $i -lt 10; $i++) {
    try {
        $p = New-Object System.IO.Pipes.NamedPipeClientStream(".", "discord-ipc-$i", [System.IO.Pipes.PipeDirection]::InOut)
        $p.Connect(250)
        if ($p.IsConnected) {
            Write-Host "SUCCESS: Connected to discord-ipc-$i" -ForegroundColor Green
            $p.Dispose()
            $found = $true
            break
        }
    } catch {}
}
if (-not $found) {
    Write-Host "No active discord-ipc pipe found in 0..9" -ForegroundColor Yellow
}
