module.exports = {
    apps: [
      {
        name:        "yamnet-classifying",
        script:      "./start_classifying.sh",
        cwd:         __dirname,
        interpreter: "bash",
        autorestart: true,
        watch:       false,
        max_restarts: 5,
        restart_delay: 5000
      },
      {
        name:        "yamnet-publish",
        script:      "./start_publishing.sh",
        cwd:         __dirname,
        interpreter: "bash",
        autorestart: true,
        watch:       false,
        max_restarts: 5,
        restart_delay: 5000
      }
    ]
  };
  