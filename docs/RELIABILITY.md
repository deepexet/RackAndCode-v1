# Надежность и отказоустойчивость

## Service tiers

| Tier | Примеры | Начальный SLO | Режим деградации |
|---|---|---|---|
| 1 Critical | auth, projects, sync, audit writes | 99.9% | read-only/offline capture |
| 2 Important | documents, search, reports | 99.5% | очередь обработки |
| 3 Auxiliary | AI enrichment, integrations | 99.0% | отключение без блокировки core |

## Обязательные механизмы

- Multi-AZ для production database и stateless replicas.
- Timeouts, bounded retries с jitter, circuit breakers и bulkheads.
- Idempotency для повторяемых commands и webhook ingestion.
- Transactional outbox вместо dual writes.
- Dead-letter queue с replay tooling и audit.
- Backpressure, queue depth alerts и workload isolation.
- Versioned backups, PITR и регулярные restore drills.
- Graceful shutdown, readiness/liveness/startup probes.
- Feature flags и автоматический rollback по health signals.

## Disaster Recovery

Начальные цели Tier-1: RPO 15 минут, RTO 60 минут. Они считаются подтвержденными только после измеренного восстановления. Backup без restore test не считается рабочей стратегией.

### Local foundation backup

```bash
npm run backup
python3 scripts/backup.py verify backups/<backup>.db
python3 scripts/backup.py restore backups/<backup>.db --target /safe/new/path/rackpilot-restored.db
```

Backup использует SQLite online backup API, поэтому не требует остановки сервиса. Каждый snapshot сопровождается manifest с SHA-256, размером, schema version и количеством organizations/workspaces. Verify выполняет checksum и `PRAGMA integrity_check`. Restore отказывается перезаписывать существующий target и сначала проверяет backup.

Local tooling создает проверяемые point-in-time snapshots, но не является continuous PITR: production RPO 15 минут потребует managed database/WAL archiving. Retention по умолчанию хранит 14 последних snapshots; удаление ограничено backup directory.

## Failure scenarios

| Сбой | Ожидаемое поведение |
|---|---|
| Потеря сети клиента | работа с local cache/outbox; явный sync state |
| Недоступен AI provider | core работает; запрос ставится в очередь/возвращает понятную деградацию |
| Недоступна интеграция | connector circuit opens; события сохраняются для retry |
| Перегрузка file processing | upload принимается; processing асинхронно ограничивается |
| Database failover | transient retry только для безопасных/idempotent операций |
| Поврежден local state | резервная копия + импорт/экспорт; clear recovery path |

## Verification cadence

- Restore test: ежемесячно.
- Game day для Tier-1: ежеквартально.
- Load/capacity test: перед major release.
- Dependency and failover review: ежемесячно.
