"""Outgoing webhook delivery worker — stdlib only.

Delivery protocol:
- POST <url> with JSON body
- Headers: X-RackPilot-Event, X-RackPilot-Delivery, X-RackPilot-Signature-256
- Signature: HMAC-SHA256(secret_key, body_bytes), hex-encoded
- secret_key is the raw secret provided at registration time;
  only SHA-256(secret_key) is stored in the DB — the raw key is supplied at send time
  via the caller (WebhookDispatcher.dispatch passes the stored hash for verification,
  but the actual signing uses the full key from registration, so the caller MUST
  store the key separately or pass it in; in this implementation we store the raw
  key encrypted by the app's master_key outside of this module — see Store.create_webhook)

Retry schedule (exponential backoff, max 5 attempts):
  attempt 1: immediate
  attempt 2: +30s
  attempt 3: +5min
  attempt 4: +30min
  attempt 5: +2h  (then give up, mark last_error)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)

_RETRY_DELAYS = [0, 30, 300, 1800, 7200]  # seconds per attempt (0-indexed)
_MAX_ATTEMPTS = len(_RETRY_DELAYS)
_DELIVERY_TIMEOUT = 10  # seconds


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _sign_payload(secret_key: str, body_bytes: bytes) -> str:
    return hmac.new(secret_key.encode(), body_bytes, hashlib.sha256).hexdigest()


def deliver_once(
    url: str,
    secret_key: str,
    event_type: str,
    delivery_id: str,
    payload: dict[str, Any],
) -> tuple[int, str | None]:
    """Send one webhook delivery. Returns (http_status, error_message|None)."""
    body_bytes = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    sig = _sign_payload(secret_key, body_bytes)
    req = urllib.request.Request(
        url,
        data=body_bytes,
        headers={
            'Content-Type': 'application/json',
            'X-RackPilot-Event': event_type,
            'X-RackPilot-Delivery': delivery_id,
            'X-RackPilot-Signature-256': f'sha256={sig}',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=_DELIVERY_TIMEOUT) as resp:
            return resp.status, None
    except urllib.error.HTTPError as exc:
        return exc.code, f'HTTP {exc.code}'
    except Exception as exc:
        return 0, str(exc)[:200]


def verify_signature(secret_key: str, body_bytes: bytes, signature_header: str) -> bool:
    """Verify incoming X-RackPilot-Signature-256 header (for incoming webhooks)."""
    expected = 'sha256=' + _sign_payload(secret_key, body_bytes)
    return hmac.compare_digest(expected, signature_header or '')


class WebhookDeliveryWorker(threading.Thread):
    """Background thread that drains the webhook_deliveries retry queue."""

    def __init__(self, store: Any, poll_interval: int = 15) -> None:
        super().__init__(daemon=True, name='WebhookDeliveryWorker')
        self._store = store
        self._poll_interval = poll_interval
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        log.info('WebhookDeliveryWorker started (poll every %ds)', self._poll_interval)
        while not self._stop_event.wait(self._poll_interval):
            try:
                self._store.flush_webhook_deliveries()
            except Exception:
                log.exception('WebhookDeliveryWorker flush error')
        log.info('WebhookDeliveryWorker stopped')
