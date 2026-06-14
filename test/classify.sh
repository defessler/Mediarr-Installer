#!/bin/bash
# ── NAS family classifier (test mirror) ───────────────────────────────────────
# Prints the nasFamily a host would be classified as. This MUST stay in sync
# with the classification in installer/src/main/env-detector.ts (the marker
# probes + their order). CI runs it inside each simulated fake-NAS and asserts
# the result matches the family the harness set up — a fast detection
# regression gate (no image pulls, no DinD).
#
# If you change the family markers or order in env-detector.ts, update this too.
set +e

synology()    { [ -f /etc/synoinfo.conf ]; }
ugreen_mark() { grep -qiE "ugreen|ugos" /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name /sys/class/dmi/id/board_vendor /etc/os-release 2>/dev/null \
                  || ls /etc 2>/dev/null | grep -qiE "ugreen|ugos"; }
asustor()     { [ -d /volume0 ] && [ -e /etc/nas.conf ]; }
terramaster() { [ -d /etc/tos ] || ls /etc 2>/dev/null | grep -qiE "^tos$"; }
zimaos()      { grep -qi "zima" /etc/os-release 2>/dev/null \
                  || { [ -d /DATA ] && { [ -e /usr/bin/casaos ] || [ -d /var/lib/casaos ]; } && ! touch /etc/.mr-rwprobe 2>/dev/null; }; }
qnap()        { [ -f /etc/config/qpkg.conf ] || [ -d /share/CACHEDEV1_DATA ]; }
unraid()      { [ -f /etc/unraid-version ]; }
truenas()     { grep -qiE "truenas|freenas" /etc/version 2>/dev/null || [ -f /etc/truenas_version ]; }
omv()         { [ -f /etc/openmediavault/config.xml ] || dpkg -l openmediavault 2>/dev/null | grep -q "^ii"; }
is_debian()   { [ -f /etc/debian_version ]; }
has_volume1() { [ -d /volume1 ]; }
# Mirror of env-detector's vendorIsGeneric guard: a DMI vendor that names a
# hypervisor / cloud / generic-PC platform means a stray /volume1 here is
# user-created, not a UGREEN appliance — so the Debian+/volume1 heuristic must
# NOT fire. Reads the world-readable sysfs node (no privilege). Empty/unreadable
# vendor → not generic → heuristic still applies (matches the TS `.test('')`).
vendor_is_generic() {
    cat /sys/class/dmi/id/sys_vendor 2>/dev/null \
        | grep -qiE "qemu|kvm|virtualbox|innotek|vmware|microsoft corporation|xen|bochs|parallels|standard pc|seabios|google|amazon|digitalocean|hetzner|oracle"
}

if   synology;                  then echo synology
elif ugreen_mark;               then echo ugreen
elif asustor;                   then echo asustor
elif terramaster;               then echo terramaster
elif zimaos;                    then echo zimaos
elif qnap;                      then echo qnap
elif unraid;                    then echo unraid
elif truenas;                   then echo truenas
elif omv;                       then echo omv
elif is_debian && has_volume1 && ! vendor_is_generic; then echo ugreen
else                                 echo linux
fi
rm -f /etc/.mr-rwprobe 2>/dev/null || true
