@echo off
set PORT=8000
if not "%1"=="" set PORT=%1
cd /d %~dp0
call .venv\Scripts\uvicorn src.app:app --host 0.0.0.0 --port %PORT%
