Name: fleet-canvas-agent
Version: 2.0.0
Release: 1%{?dist}
Summary: Fleet Canvas managed device agent
License: Proprietary
BuildArch: %{_arch}
Requires: nodejs >= 22
Requires(pre): shadow-utils
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd

%description
Fleet Canvas telemetry and authorized remote execution agent.

%install
mkdir -p %{buildroot}/opt/fleet-canvas/agent %{buildroot}%{_unitdir} %{buildroot}%{_sbindir} %{buildroot}%{_docdir}/fleet-canvas-agent
cp -a %{_sourcedir}/bundle/. %{buildroot}/opt/fleet-canvas/agent/
install -m 0755 %{_sourcedir}/fleet-agent-configure %{buildroot}%{_sbindir}/fleet-agent-configure
install -m 0644 %{_sourcedir}/package-install.example.json %{buildroot}%{_docdir}/fleet-canvas-agent/package-install.example.json
sed -e 's|__INSTALL_DIR__|/opt/fleet-canvas/agent|g' -e 's|__ENV_FILE__|/etc/fleet-canvas/agent.env|g' -e 's|__SERVICE_USER__|fleet-agent|g' -e 's|__SERVICE_GROUP__|fleet-agent|g' %{_sourcedir}/fleet-canvas-agent.service > %{buildroot}%{_unitdir}/fleet-canvas-agent.service

%pre
getent group fleet-agent >/dev/null || groupadd -r fleet-agent
if ! getent passwd fleet-agent >/dev/null; then
  useradd -r -g fleet-agent -d /var/lib/fleet-canvas-agent -s /sbin/nologin fleet-agent
fi

%post
install -d -m 0750 -o fleet-agent -g fleet-agent /var/lib/fleet-canvas-agent
install -d -m 0750 -o root -g fleet-agent /etc/fleet-canvas
if [ -f /etc/fleet-canvas/package-install.json ]; then
  %{_sbindir}/fleet-agent-configure --config-file /etc/fleet-canvas/package-install.json --consume-inputs
elif [ ! -f /etc/fleet-canvas/agent.env ]; then
  %{_sbindir}/fleet-agent-configure
fi
chown root:fleet-agent /etc/fleet-canvas/agent.env
chmod 0640 /etc/fleet-canvas/agent.env
%systemd_post fleet-canvas-agent.service
if [ -d /run/systemd/system ]; then systemctl enable --now fleet-canvas-agent.service >/dev/null || exit $?; fi

%preun
%systemd_preun fleet-canvas-agent.service

%postun
%systemd_postun_with_restart fleet-canvas-agent.service

%files
/opt/fleet-canvas/agent
%{_sbindir}/fleet-agent-configure
%{_unitdir}/fleet-canvas-agent.service
%doc %{_docdir}/fleet-canvas-agent/package-install.example.json

%changelog
* Wed Jul 15 2026 Fleet Canvas Administrators - 2.0.0-1
- Initial unsigned, dependency-complete package
