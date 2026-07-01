# Эксплуатация и наблюдаемость

## Телеметрия

Все сервисы используют структурированные logs, metrics и distributed traces с едиными `trace_id`, `tenant_id` (псевдонимизированным), `service`, `version`, `region`. Запрещено писать токены, пароли, содержимое документов и чувствительные конфигурации.

Ключевые сигналы: latency, traffic, errors, saturation, queue lag, sync age, failed jobs, DB pool, storage errors и AI provider health/cost.

## Alerting

Alerts привязаны к пользовательскому воздействию и error budget. Каждый paging alert MUST иметь owner и runbook. Низкоприоритетные симптомы уходят в dashboard/ticket, а не будят on-call.

## Release

1. Contract, unit, integration и migration tests.
2. Security and dependency gates.
3. Staging smoke + synthetic critical paths.
4. Progressive rollout/canary.
5. Automatic health evaluation и rollback.
6. Post-deploy verification и release annotation.

## Foundation CI gate

GitHub Actions запускает JavaScript/Python syntax checks, unit и tenant-isolation tests, mobile frontend contracts, roadmap dependency validation, CycloneDX SBOM consistency и secret-pattern scan. Workflow использует read-only repository permissions, отключает сохранение checkout credentials, ограничен десятью минутами и отменяет устаревшие запуски той же ветки.

## Инциденты

Роли: Incident Commander, Operations Lead, Communications, Scribe. После значимого инцидента создается blameless review с timeline, contributing factors и отслеживаемыми corrective actions.

## Runbook template

- Симптом и impact.
- Dashboard/query links.
- Безопасная диагностика.
- Mitigation и rollback.
- Escalation/owner.
- Recovery verification.

## Backup runbook

- Создать snapshot: `npm run backup`.
- Проверить snapshot: `python3 scripts/backup.py verify <path>`.
- Восстанавливать только в новый путь; существующая live DB не перезаписывается tooling.
- Запустить восстановленную копию на отдельном порту и проверить health, schema version и task count.

## macOS Compute Agent

На Mac, где запущен RackPilot server:

```bash
python3 scripts/mac_agent.py --name "M1 Pro" --compute-enabled
```

На втором Mac скопируйте только `scripts/mac_agent.py` и содержимое локального `data/agent.token`, затем запустите:

```bash
RACKPILOT_AGENT_TOKEN='<enrollment token>' python3 mac_agent.py \
  --server http://192.168.8.138:4173 --name "M1 Air" --compute-enabled
```

Без `--compute-enabled` устройство передает telemetry, но не может получить вычислительную задачу. Окончательное разрешение задается отдельно в Admin. Token нельзя добавлять в Git, логи или screenshots; при компрометации удалите `data/agent.token` и перезапустите server для генерации нового.
- Переключение production traffic требует отдельного change approval и rollback plan.
- `RACKPILOT_DEPLOYMENT_MODE=development` enables verified agent auto-integration and idle-safe local service reloads. `production` keeps agent output in review; production promotion must use a separate staging environment, explicit approval, backup and rollback checks.
