# Безопасность и конфиденциальность

## Baseline

Ориентиры: OWASP ASVS, OWASP API Security Top 10, NIST SSDF и принцип zero trust. Финальные compliance controls определяются рынком и контрактами клиентов.

## Контроли

- OIDC/OAuth 2.1, phishing-resistant MFA для privileged roles.
- Deny-by-default authorization на каждом server-side resource access.
- Строгая tenant isolation в application layer и database policies.
- TLS в transit, managed encryption keys at rest, rotation и separation of duties.
- Secrets только в secret manager; запрет секретов в коде, логах и AI context.
- Signed artifacts, SBOM, dependency scanning, SAST/DAST и protected releases.
- File scanning, content-type validation, quarantine и ограниченные signed URLs.
- Rate limiting, abuse detection и защищенный webhook verification.
- Privacy controls для device/application monitoring: purpose, consent, retention, minimization.

## MVP RBAC boundary

`X-RackPilot-Role` is a development-only role preview header used by the local MVP to test route-level policies. It must not be treated as production authentication. Commercial or multi-company deployment requires signed sessions, real users, organization memberships, persisted role assignments and server-side policy evaluation independent of client-controlled headers.

## AI threat model

- Документы и внешние данные считаются недоверенным вводом.
- Prompt injection не может расширять permissions или tool access.
- Retrieval фильтруется до передачи модели.
- Tool calls проходят allowlist, validation и approval policy.
- Sensitive data classification определяет допустимых model providers.
- AI output помечается как generated и не заменяет authoritative configuration.

## Security incident priorities

P0: active tenant isolation breach, credential compromise, destructive unauthorized access. Первые действия: contain, preserve evidence, rotate/revoke, assess scope, communicate по incident plan.
