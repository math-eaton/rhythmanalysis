#!/usr/bin/env bash
#
# Automated Wi-Fi monitor and recovery script for Raspberry Pi 3B+

# Configuration
INTERFACE="wlan0"
PING_COUNT=2
LOG_FILE="/var/log/check_wifi.log"
REBOOT_ON_FAILURE="${REBOOT_ON_FAILURE:-false}"

# Determine ping target (default gateway)
GATEWAY=$(ip route | awk '/default/ { print $3 }')
TARGET="${GATEWAY:-8.8.8.8}"

# Timestamp function
timestamp() { date +"%Y-%m-%d %H:%M:%S"; }

# Log header
echo "[$(timestamp)] Checking $INTERFACE via ping to $TARGET" >> "$LOG_FILE"

# Ping test
if ! ping -I "$INTERFACE" -c "$PING_COUNT" "$TARGET" &> /dev/null; then
  echo "[$(timestamp)] Ping failed; restarting $INTERFACE" >> "$LOG_FILE"
  ip link set dev "$INTERFACE" down
  sleep 5
  ip link set dev "$INTERFACE" up
  sleep 5

  # Second ping
  if ! ping -I "$INTERFACE" -c "$PING_COUNT" "$TARGET" &> /dev/null; then
    echo "[$(timestamp)] Interface restart failed; restarting dhcpcd" >> "$LOG_FILE"
    systemctl restart dhcpcd.service

    sleep 10
    if ! ping -I "$INTERFACE" -c "$PING_COUNT" "$TARGET" &> /dev/null; then
      echo "[$(timestamp)] dhcpcd restart failed" >> "$LOG_FILE"
      if [ "$REBOOT_ON_FAILURE" = "true" ]; then
        echo "[$(timestamp)] Rebooting system as last resort" >> "$LOG_FILE"
        systemctl reboot
      fi
    else
      echo "[$(timestamp)] dhcpcd restart succeeded" >> "$LOG_FILE"
    fi
  else
    echo "[$(timestamp)] Interface restart succeeded" >> "$LOG_FILE"
  fi
else
  echo "[$(timestamp)] Connection OK" >> "$LOG_FILE"
fi
