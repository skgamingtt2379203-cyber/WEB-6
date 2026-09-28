$clientId = "383226320970055681"
$gifUrl = "https://files.catbox.moe/fi131s.gif"

function Write-Packet($stream, [int]$opcode, [string]$json) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $len = $bytes.Length
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([int]$opcode)
    $writer.Write([int]$len)
    $writer.Write($bytes)
    $writer.Flush()
}

function Read-Packet($stream) {
    $reader = New-Object System.IO.BinaryReader($stream)
    $op = $reader.ReadInt32()
    $len = $reader.ReadInt32()
    $bytes = $reader.ReadBytes($len)
    $json = [System.Text.Encoding]::UTF8.GetString($bytes)
    return @{ Opcode = $op; Json = $json }
}

try {
    $pipe = $null
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $p = New-Object System.IO.Pipes.NamedPipeClientStream(".", "discord-ipc-$i", [System.IO.Pipes.PipeDirection]::InOut)
            $p.Connect(400)
            if ($p.IsConnected) {
                $pipe = $p
                Write-Host "Connected to discord-ipc-$i" -ForegroundColor Green
                break
            }
        } catch {}
    }

    if (-not $pipe) {
        Write-Host "No Discord IPC pipe found. Is Discord Desktop running?" -ForegroundColor Yellow
        exit 1
    }

    # 1. Send Handshake
    $handshakeJson = '{"v":1,"client_id":"' + $clientId + '"}'
    Write-Packet $pipe 0 $handshakeJson
    $res = Read-Packet $pipe
    Write-Host "Handshake Response:" $res.Json

    # 2. Send SET_ACTIVITY
    $startTime = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    $actObj = @{
        cmd = "SET_ACTIVITY"
        args = @{
            pid = $PID
            activity = @{
                state = "Amplifying Voice [D4Hz]"
                details = "D4Hz WEB - High Frequency Audio"
                timestamps = @{
                    start = $startTime
                }
                assets = @{
                    large_image = $gifUrl
                    large_text = "D4Hz - DEATH"
                    small_image = $gifUrl
                    small_text = "D4Hz WEB"
                }
                buttons = @(
                    @{ label = "D4Hz"; url = "https://github.com" }
                )
            }
        }
        nonce = [Guid]::NewGuid().ToString()
    }
    $actJson = ConvertTo-Json -InputObject $actObj -Depth 6 -Compress
    Write-Host "Sending activity JSON:" $actJson
    Write-Packet $pipe 1 $actJson
    $actRes = Read-Packet $pipe
    Write-Host "Set Activity Response:" $actRes.Json

    Write-Host "SUCCESS: Discord Profile Activity updated with DEATH.gif!"
    $pipe.Close()
} catch {
    Write-Host "Error: $_"
}
