@echo off
rem Abre o TCL Ar na bandeja do Windows (ao lado do relogio). Use "iniciar.bat --demo" para ver sem conta.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
