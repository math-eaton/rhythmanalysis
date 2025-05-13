import subprocess

def convert_md_to_slides(input_md, output_html):
    pandoc_command = [
        "pandoc",
        input_md,
        "-t", "revealjs",
        "-s",
        "-o", output_html,
        "--slide-level=2",  # Level of headers to split slides (##)
        "-V", "revealjs-url=https://revealjs.com"  # Hosted Reveal.js CDN
    ]

    try:
        subprocess.run(pandoc_command, check=True)
        print(f"Slides successfully generated: {output_html}")
    except subprocess.CalledProcessError as e:
        print(f"An error occurred during Pandoc conversion: {e}")

if __name__ == "__main__":
    input_md = "README.md"  # Change this to your markdown file path
    output_html = "README_slides.html"  # Desired output file name
    convert_md_to_slides(input_md, output_html)
