import json

def round_cf_values(json_file):
    with open(json_file, 'r') as f:
        data = json.load(f)

    # Round key values to desired res
    for entry in data:
        if "cf" in entry:
            entry["cf"] = round(entry["cf"], 1)

    # Write the updated data back to the file
    with open(json_file, 'w') as f:
        json.dump(data, f, indent=4)

if __name__ == "__main__":
    json_file = "classifications.json"
    round_cf_values(json_file)
    print(f"Rounded values in {json_file}")
