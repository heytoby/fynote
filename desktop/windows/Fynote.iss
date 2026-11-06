[Setup]
AppId=Fynote.Desktop
AppName=Fynote
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Fynote Installer
DefaultDirName={localappdata}\Programs\Fynote
DefaultGroupName=Fynote
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
AppMutex=Local\FynoteDesktop
OutputDir={#OutputDirectory}
OutputBaseFilename=fynote-Setup-{#AppVersion}
Compression=lzma2/fast
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\fynote.exe

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#PackageRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Fynote"; Filename: "{app}\fynote.exe"
Name: "{autodesktop}\Fynote"; Filename: "{app}\fynote.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\fynote.exe"; Description: "Launch Fynote"; Flags: nowait postinstall skipifsilent

[INI]
Filename: "{app}\installation.ini"; Section: "Fynote"; Key: "ManagedBySetup"; String: "1"
