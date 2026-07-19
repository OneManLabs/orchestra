# Integration boundaries

Fleet Canvas deliberately fails or reports metadata-only state when an external integration is not actually available. The interface should not present an unavailable capability as operational.

| Capability | What this repository ships | Boundary that remains |
| --- | --- | --- |
| Agent distribution | Development PKG, MSI, DEB, and RPM candidates; native service definitions; enrollment inputs; update staging and rollback requests | Production packages require Apple notarization, Authenticode, APT/RPM signing, and privileged service activation |
| Core availability | Durable atomic state, encrypted backup, validated restore, Compose/service/NAS assets, single-replica Kubernetes manifest | Core is a single-active-instance JSON store, not an HA database or multi-site replication system |
| Remote visual control | Launch adapters for installed RDP, VNC, macOS Screen Sharing, Sunshine, and explicit external URLs | No embedded WebRTC stream, audio, recording, or multi-monitor transport |
| Mobile and notifications | Responsive PWA, native iOS client, local notifications, inbox, webhooks | No hosted APNs/Web Push delivery service, SMS service, or biometric approval backend |
| Identity and governance | Recovery credential, scoped tokens, device credentials, role/member records, policy foundations, audit chain | No bundled human SSO/session service, SAML/OIDC/SCIM, attestation, KMS, SIEM, or compliance certification |
| Storage and transfers | Confined Core/Agent/mounted-NAS browsing, resumable transfer, integrity validation | Object-store registration does not imply complete direct S3/MinIO transfer or automatic mounting |
| Plugins and hybrid compute | Manifest and SDK contracts, REST, MCP, webhooks, development simulator | Core does not execute arbitrary marketplace plugins or provision cloud/Kubernetes workers |
