# Integration limits

Orchestra shows a function as unavailable when its external integration is not present. The interface must not show an unavailable function as operational.

| Function | Included | Not included |
| --- | --- | --- |
| Agent packages | Development PKG, MSI, DEB, and RPM files | Production signing, notarization, and privileged activation |
| Core state | Atomic state, encrypted backup, restore checks, and deployment files | High-availability database and multi-site replication |
| Remote desktop | RDP, VNC, Screen Sharing, Sunshine, and URL launch adapters | Built-in video, audio, recording, and monitor transport |
| Mobile | PWA, iOS client, local notifications, inbox, and webhooks | Hosted APNs, Web Push, SMS, and biometric server |
| Identity | Recovery token, scoped tokens, device credentials, roles, and policy | SSO, SAML, OIDC, SCIM, attestation, KMS, SIEM, and certification |
| Storage | Restricted file access, restartable transfer, and integrity checks | Complete direct S3 or MinIO transfer and automatic mounts |
| Plugins | Manifests, SDK contracts, REST, MCP, and webhooks | Execution of arbitrary marketplace plugins |
| Compute | Local scheduling and simulator devices | Automatic cloud or Kubernetes worker creation |
