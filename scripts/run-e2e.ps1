$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$pgName = "sentinelpr-pg-e2e-$suffix"
$redisName = "sentinelpr-redis-e2e-$suffix"
$oldDb = $env:DATABASE_URL
$oldRedis = $env:REDIS_URL
$oldE2eDb = $env:E2E_DATABASE_URL
$oldE2eRedis = $env:E2E_REDIS_URL
$exitCode = 0

function Get-MappedPort([string]$container, [string]$port) {
  $mapping = docker inspect --format '{{json .NetworkSettings.Ports}}' $container
  if ($LASTEXITCODE -ne 0 -or -not $mapping) {
    throw "Could not determine mapped port for $container/$port"
  }
  $bindings = $mapping | ConvertFrom-Json
  $entry = $bindings.PSObject.Properties[$port]
  $binding = if ($entry) { $entry.Value | Select-Object -First 1 } else { $null }
  if (-not $binding -or -not $binding.HostPort) {
    throw "Docker inspect returned no host port for $container/$port"
  }
  return [string]$binding.HostPort
}

try {
  docker run -d --name $pgName -p 127.0.0.1::5432 -e POSTGRES_USER=sentinel -e POSTGRES_PASSWORD=sentinel -e POSTGRES_DB=postgres postgres:17-alpine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start disposable PostgreSQL container' }
  docker run -d --name $redisName -p 127.0.0.1::6379 redis:7-alpine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start disposable Redis container' }

  $pgPort = Get-MappedPort $pgName '5432/tcp'
  $redisPort = Get-MappedPort $redisName '6379/tcp'

  $pgReady = $false
  for ($i = 0; $i -lt 45; $i++) {
    docker exec $pgName pg_isready -U sentinel -d postgres *> $null
    if ($LASTEXITCODE -eq 0) { $pgReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $pgReady) { throw 'Disposable PostgreSQL did not become ready' }

  $redisReady = $false
  for ($i = 0; $i -lt 30; $i++) {
    docker exec $redisName redis-cli ping 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $redisReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $redisReady) { throw 'Disposable Redis did not become ready' }

  docker exec $pgName createdb -U sentinel sentinelpr_e2e | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create sentinelpr_e2e database' }

  $env:E2E_DATABASE_URL = "postgresql://sentinel:sentinel@127.0.0.1:$pgPort/sentinelpr_e2e?schema=public"
  $env:E2E_REDIS_URL = "redis://127.0.0.1:$redisPort/1"
  $env:DATABASE_URL = $env:E2E_DATABASE_URL

  & .\node_modules\.bin\prisma.cmd migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Prisma migrations failed on E2E database' }

  & .\node_modules\.bin\playwright.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Playwright E2E suite failed' }
}
catch {
  $exitCode = 1
  Write-Output ("ERROR: " + $_.Exception.Message)
}
finally {
  if ($null -eq $oldDb) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue } else { $env:DATABASE_URL = $oldDb }
  if ($null -eq $oldRedis) { Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue } else { $env:REDIS_URL = $oldRedis }
  if ($null -eq $oldE2eDb) { Remove-Item Env:E2E_DATABASE_URL -ErrorAction SilentlyContinue } else { $env:E2E_DATABASE_URL = $oldE2eDb }
  if ($null -eq $oldE2eRedis) { Remove-Item Env:E2E_REDIS_URL -ErrorAction SilentlyContinue } else { $env:E2E_REDIS_URL = $oldE2eRedis }
  docker rm -f $pgName $redisName 2>$null | Out-Null
}

exit $exitCode
