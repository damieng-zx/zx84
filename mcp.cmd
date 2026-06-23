@echo off
cd /d "%~dp0"
npx --no-install tsx mcp/server.ts
