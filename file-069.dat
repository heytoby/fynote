[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^(0|[1-9]\d{0,5})(\.(0|[1-9]\d{0,5})){2}$') {
    throw 'Fynote requires a stable major.minor.patch version.'
}

$builtIndex = Join-Path $projectRoot 'dist\keep\index.html'
if (-not [IO.File]::Exists($builtIndex)) { throw 'Run npm run build before packaging.' }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stage = [IO.Path]::GetFullPath((Join-Path $tempRoot ('fynote-package-' + [Guid]::NewGuid().ToString('N'))))
$packageRoot = Join-Path $stage 'fynote'
$payload = Join-Path $packageRoot "versions\$version"
$app = Join-Path $payload 'app'
$runtime = Join-Path $payload 'runtime'
$encoding = [Text.UTF8Encoding]::new($false)
$node = (Get-Command node.exe -ErrorAction Stop).Source

try {
    [void][IO.Directory]::CreateDirectory($app)
    [void][IO.Directory]::CreateDirectory($runtime)
    foreach ($item in @('dist', 'server', 'shared', 'mcp', 'package.json', 'package-lock.json', 'LICENCE.MD', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $app -Recurse
    }
    Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
    $nodeLicense = Join-Path (Split-Path -Parent $node) 'LICENSE'
    if ([IO.File]::Exists($nodeLicense)) {
        Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtime 'LICENSE')
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENCE.MD'), (Join-Path $projectRoot 'LICENSE') -Destination $packageRoot
    [IO.File]::WriteAllText((Join-Path $packageRoot 'current.json'), (ConvertTo-Json @{ version = $version } -Compress), $encoding)
    $instructions = @"
Fynote $version · Windows x64

解压完整文件夹后双击 fynote.exe。首次从旧版升级前，请先退出旧版。
笔记保存在 %LOCALAPPDATA%\Kept\data。
在设置的「软件更新」里检查新版本并安装。

项目源码 https://github.com/heytoby/fynote
开源许可见 LICENCE.MD。
"@
    [IO.File]::WriteAllText((Join-Path $packageRoot 'README.txt'), $instructions, $encoding)

    Push-Location -LiteralPath $app
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "Runtime dependency install failed ($LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $launcher = Join-Path $packageRoot 'fynote.exe'
    $compilerArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
        '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
        "/out:$launcher", (Join-Path $projectRoot 'desktop\windows\Launcher.cs')
    )
    & $compiler @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw "Launcher compile failed ($LASTEXITCODE)." }

    # Probe the packaged runtime with a fresh temporary database before releasing it.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $address = "http://127.0.0.1:$port"
    $probe = [Diagnostics.ProcessStartInfo]::new((Join-Path $runtime 'node.exe'), 'server/server.js')
    $probe.WorkingDirectory = $app
    $probe.UseShellExecute = $false
    $probe.CreateNoWindow = $true
    $probe.EnvironmentVariables['NODE_ENV'] = 'production'
    $probe.EnvironmentVariables['PORT'] = [string]$port
    $probe.EnvironmentVariables['BASE_URL'] = $address
    $probe.EnvironmentVariables['DATA_DIR'] = Join-Path $stage 'smoke-data'
    $probe.EnvironmentVariables['FYNOTE_DESKTOP_ROOT'] = $packageRoot
    $probe.EnvironmentVariables['KEPT_TEST_MODE'] = '1'
    $server = [Diagnostics.Process]::Start($probe)
    try {
        $ready = $false
        for ($attempt = 0; $attempt -lt 40 -and -not $server.HasExited; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri "$address/api/health" -TimeoutSec 2 -NoProxy
                if ($response.StatusCode -eq 200 -and $response.Headers['X-Fynote-Desktop-Version'] -contains $version) {
                    $ready = $true
                    break
                }
            } catch {}
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'The packaged server failed its health check.' }
        $home = Invoke-WebRequest -Uri $address -TimeoutSec 4 -NoProxy
        if ($home.StatusCode -ne 200 -or $home.Content -notmatch '<app-root') {
            throw 'The packaged frontend did not load.'
        }
    } finally {
        if (-not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
        $server.Dispose()
    }

    [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory))
    $archiveName = "fynote-$version-windows-x64.zip"
    $archive = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $archiveName))
    $temporaryArchive = Join-Path $stage $archiveName
    Add-Type -AssemblyName System.IO.Compression.ZipFile
    [IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $temporaryArchive, [IO.Compression.CompressionLevel]::Optimal, $true)
    [IO.File]::Move($temporaryArchive, $archive)
    Write-Output $archive
} finally {
    if ([IO.Directory]::Exists($stage) -and [IO.Path]::GetDirectoryName($stage).TrimEnd('\') -eq $tempRoot.TrimEnd('\')) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
