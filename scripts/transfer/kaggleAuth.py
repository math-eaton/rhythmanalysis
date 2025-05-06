import kagglehub

# Authenticate
kagglehub.login() # This will prompt you for your credentials.
# We also offer other ways to authenticate (credential file & env variables): https://github.com/Kaggle/kagglehub?tab=readme-ov-file#authenticate

# Download latest version
path = kagglehub.model_download("google/yamnet/tensorFlow2/yamnet")

print("Path to model files:", path)
