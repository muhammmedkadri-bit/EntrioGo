' Cargobar Print Agent - Gizli Arka Plan Başlatıcı
' Bilgisayar her açıldığında ajan görünmez şekilde otomatik başlar.
'
' Kurulum: Bu dosyanın kısayolunu shell:startup klasörüne koy.

Dim fso, scriptDir, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = "node.exe"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists("C:\Program Files (x86)\nodejs\node.exe") Then
    nodeExe = "C:\Program Files (x86)\nodejs\node.exe"
End If

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = scriptDir
WshShell.Run """" & nodeExe & """ """ & scriptDir & "\server.js""", 0, False
