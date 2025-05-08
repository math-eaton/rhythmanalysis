module.exports = {
    apps: [
      {
        name:             "yamnet-classifying",
        script:           "./start_classifying.sh",
        cwd:              __dirname,
        interpreter:      "bash",
        autorestart:      true,
        watch:            false,
        max_restarts:     10,
        restart_delay:    5000,
        min_uptime:       "60s",
        max_memory_restart: "300M",
        env: {
          // script vars
        },
        error_file:       "./logs/classify.err.log",
        out_file:         "./logs/classify.out.log",
        merge_logs:       true,
        log_date_format:  "YYYY-MM-DD HH:mm Z"
      },
      {
        name:             "yamnet-publish",
        script:           "./start_publishing.sh",
        cwd:              __dirname,
        interpreter:      "bash",
        autorestart:      true,
        watch:            false,
        max_restarts:     10,
        restart_delay:    5000,
        min_uptime:       "60s",
        max_memory_restart: "150M",
        error_file:       "./logs/publish.err.log",
        out_file:         "./logs/publish.out.log",
        merge_logs:       true,
        log_date_format:  "YYYY-MM-DD HH:mm Z"
      }
    ]
  };
  