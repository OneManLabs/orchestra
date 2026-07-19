"""Dependency-free Fleet Canvas V2 API client."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


@dataclass
class FleetApiError(RuntimeError):
    status: int
    message: str
    detail: Any = None

    def __str__(self) -> str:
        return self.message


class FleetClient:
    def __init__(self, base_url: str, token: str | None = None, timeout: float = 30.0) -> None:
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password:
            raise ValueError("base_url must not contain credentials")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain a query or fragment")
        if token and ("\r" in token or "\n" in token):
            raise ValueError("token contains invalid control characters")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive finite number")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._opener = build_opener(_NoRedirectHandler())

    def snapshot(self) -> dict[str, Any]:
        return self.request("/api/snapshot")

    def v2(self) -> dict[str, Any]:
        return self.request("/api/v2")

    def list(self, resource: str) -> list[dict[str, Any]]:
        self._validate_resource(resource)
        return self.request(f"/api/v2/{resource}")

    def create(self, resource: str, body: Mapping[str, Any]) -> dict[str, Any]:
        self._validate_resource(resource)
        return self.request(f"/api/v2/{resource}", "POST", body)

    def update(self, resource: str, entity_id: str, body: Mapping[str, Any]) -> dict[str, Any]:
        self._validate_resource(resource)
        return self.request(f"/api/v2/{resource}/{self._segment(entity_id)}", "PATCH", body)

    def delete(self, resource: str, entity_id: str) -> None:
        self._validate_resource(resource)
        self.request(f"/api/v2/{resource}/{self._segment(entity_id)}", "DELETE")

    def power(self, device_ids: list[str], action: Literal["wake", "sleep", "restart", "shutdown", "lock", "logout"], *, force: bool = False) -> Any:
        if not device_ids or any(not item for item in device_ids):
            raise ValueError("device_ids must contain at least one non-empty identifier")
        if action not in {"wake", "sleep", "restart", "shutdown", "lock", "logout"}:
            raise ValueError("unsupported power action")
        return self.request("/api/v2/devices/power", "POST", {
            "deviceIds": device_ids,
            "action": action,
            "force": force,
        })

    def run_pipeline(self, pipeline_id: str, parameters: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return self.request(
            f"/api/v2/pipelines/{self._segment(pipeline_id)}/run",
            "POST",
            {"parameters": dict(parameters or {})},
        )

    def create_enrollment_token(
        self, label: str, *, role: str | None = None, expires_in_seconds: int = 900, max_uses: int = 1
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "label": label,
            "expiresInSeconds": expires_in_seconds,
            "maxUses": max_uses,
        }
        if role:
            body["role"] = role
        return self.request("/api/v2/enrollment/tokens", "POST", body)

    def request(self, path: str, method: str = "GET", body: Mapping[str, Any] | None = None) -> Any:
        if not path.startswith("/") or path.startswith("//") or "://" in path or "\\" in path or "#" in path or any(ord(char) < 32 or ord(char) == 127 for char in path):
            raise ValueError("path must be relative to Fleet Core")
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = Request(f"{self.base_url}{path}", method=method, headers=headers, data=data)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:  # noqa: S310 - URL is operator configured
                if response.status == 204:
                    return None
                raw = response.read()
                if not raw:
                    return None
                content_type = response.headers.get("content-type", "")
                if "application/json" in content_type or "+json" in content_type:
                    try:
                        return json.loads(raw)
                    except json.JSONDecodeError as error:
                        raise FleetApiError(response.status, "Fleet Core returned invalid JSON", raw[:4096]) from error
                return raw.decode("utf-8", errors="replace")
        except HTTPError as error:
            raw = error.read()
            try:
                detail = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                detail = raw.decode("utf-8", errors="replace")
            message = detail.get("error") if isinstance(detail, dict) else f"Fleet API request failed ({error.code})"
            raise FleetApiError(error.code, str(message), detail) from error

    @staticmethod
    def _validate_resource(resource: str) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9-]*", resource):
            raise ValueError("invalid Fleet resource name")

    @staticmethod
    def _segment(value: str) -> str:
        if not value or "/" in value or ".." in value:
            raise ValueError("invalid Fleet resource identifier")
        return quote(value, safe="")


class _NoRedirectHandler(HTTPRedirectHandler):
    """Prevent bearer credentials from following redirects to another origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None
