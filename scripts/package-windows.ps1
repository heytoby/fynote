[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $OutputDirectory,
    [switch] $BuildInstaller
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

    $electronVersion = '45.2.3'
    $electronArchive = Join-Path $stage 'electron.zip'
    $electronUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/electron-v$electronVersion-win32-x64.zip"
    Invoke-WebRequest -Uri $electronUrl -OutFile $electronArchive -TimeoutSec 180
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $electronArchive).Hash -ne '489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0') {
        throw 'Electron runtime checksum mismatch.'
    }
    $windowRuntime = Join-Path $payload 'window'
    Expand-Archive -LiteralPath $electronArchive -DestinationPath $windowRuntime
    Copy-Item -LiteralPath (Join-Path $projectRoot 'desktop\windows\window') -Destination (Join-Path $windowRuntime 'resources\app') -Recurse

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
    $probe.RedirectStandardInput = $true
    $probe.EnvironmentVariables['NODE_ENV'] = 'production'
    $probe.EnvironmentVariables['PORT'] = [string]$port
    $probe.EnvironmentVariables['BASE_URL'] = $address
    $probe.EnvironmentVariables['DATA_DIR'] = Join-Path $stage 'smoke-data'
    $probe.EnvironmentVariables['FYNOTE_DESKTOP_ROOT'] = $packageRoot
    $probe.EnvironmentVariables['KEPT_TEST_MODE'] = '1'
    $probe.EnvironmentVariables['FYNOTE_CLOSE_ON_STDIN_END'] = '1'
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
        $homeResponse = Invoke-WebRequest -Uri $address -TimeoutSec 4 -NoProxy
        if ($homeResponse.StatusCode -ne 200 -or $homeResponse.Content -notmatch '<app-root') {
            throw 'The packaged frontend did not load.'
        }
        $windowProbe = Start-Process -FilePath (Join-Path $windowRuntime 'electron.exe') -ArgumentList @(
            "--fynote-port=$port", ('--fynote-profile="' + (Join-Path $stage 'window-smoke') + '"'), '--fynote-smoke'
        ) -PassThru
        try {
            if (-not $windowProbe.WaitForExit(30000)) {
                $windowProbe.Kill()
                $windowProbe.WaitForExit()
                throw 'The packaged desktop window timed out.'
            }
            if ($windowProbe.ExitCode -ne 0) { throw "The desktop window failed to load ($($windowProbe.ExitCode))." }
        } finally { $windowProbe.Dispose() }
        $server.StandardInput.Close()
        if (-not $server.WaitForExit(15000) -or $server.ExitCode -ne 0) {
            throw 'The packaged server did not shut down cleanly.'
        }
    } finally {
        if (-not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
        $server.Dispose()
    }

    [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory))
    if (-not $BuildInstaller) {
        $archiveName = "fynote-$version-windows-x64.zip"
        $archive = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $archiveName))
        $temporaryArchive = Join-Path $stage $archiveName
        Add-Type -AssemblyName System.IO.Compression.ZipFile
        [IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $temporaryArchive, [IO.Compression.CompressionLevel]::Optimal, $true)
        [IO.File]::Move($temporaryArchive, $archive)
        Write-Output $archive
    }

    if ($BuildInstaller) {
        $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
        if (-not (Test-Path -LiteralPath $iscc)) { throw 'Inno Setup 6 is required.' }
        $installerScript = Join-Path $projectRoot 'desktop\windows\Fynote.iss'
        & $iscc "/DAppVersion=$version" "/DPackageRoot=$packageRoot" "/DOutputDirectory=$([IO.Path]::GetFullPath($OutputDirectory))" $installerScript
        if ($LASTEXITCODE -ne 0) { throw "Installer compile failed ($LASTEXITCODE)." }

        $installer = Join-Path $OutputDirectory "fynote-Setup-$version.exe"
        $installerMetadata = [Diagnostics.FileVersionInfo]::GetVersionInfo([IO.Path]::GetFullPath($installer))
        if ($installerMetadata.ProductName.Trim() -ne 'Fynote Installer' -or $installerMetadata.FileVersion.Trim() -ne $version) {
            throw 'Installer metadata does not match the updater requirements.'
        }
        $installProbe = Join-Path $stage 'installed'
        $setup = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $installProbe + '"')) -Wait -PassThru
        if ($setup.ExitCode -ne 0 -or -not (Test-Path (Join-Path $installProbe 'fynote.exe'))) {
            throw "Installer smoke test failed ($($setup.ExitCode))."
        }
        $installed = Get-Content -Raw -LiteralPath (Join-Path $installProbe 'current.json') | ConvertFrom-Json
        if ($installed.version -ne $version) { throw 'Installer did not activate the packaged version.' }
    }
} finally {
    if ([IO.Directory]::Exists($stage) -and [IO.Path]::GetDirectoryName($stage).TrimEnd('\') -eq $tempRoot.TrimEnd('\')) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
