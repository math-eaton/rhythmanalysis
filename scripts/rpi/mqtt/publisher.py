import paho.mqtt.client as mqtt
import pandas as pd
import time
import ssl
import json
import os

# Load configuration from config.json
config_path = os.path.join(os.path.dirname(__file__), "config.json")
with open(config_path, "r") as config_file:
    config = json.load(config_file)

# HiveMQ MQTT Broker configuration
broker = config["hiveMQ_broker"]
port = config["hiveMQ_port"]
username = config["hiveMQ_username"]
password = config["hiveMQ_password"]
topic = config["topic"]
interval_seconds = config["interval_seconds"]

# Load CSV data
data = pd.read_csv("output/classifications.csv")

# Initialize MQTT client with TLS
client = mqtt.Client()
client.username_pw_set(username, password)
client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)

# Connect securely to HiveMQ Cloud
client.connect(broker, port)

# Publish loop
try:
    for idx, row in data.iterrows():
        payload = row.to_json()
        client.publish(topic, payload)
        print(f"Published: {payload}")
        time.sleep(interval_seconds)
except KeyboardInterrupt:
    print("Terminated by user")
finally:
    client.disconnect()
