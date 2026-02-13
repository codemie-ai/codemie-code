#!/bin/bash

# play-random-sound.sh
# Plays a random WAV file from the specified directory
# Usage: ./play-random-sound.sh <directory>

set -e

# Check if directory argument is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <directory>" >&2
    echo "Example: $0 ~/.codemie/claude-plugin/sounds/acolyte" >&2
    exit 1
fi

# Expand tilde in the directory path
SOUND_DIR="${1/#\~/$HOME}"

# Check if directory exists
if [ ! -d "$SOUND_DIR" ]; then
    echo "Error: Directory not found: $SOUND_DIR" >&2
    exit 1
fi

# Find all audio files and store in array (compatible way)
WAV_FILES=()
while IFS= read -r -d '' file; do
    WAV_FILES+=("$file")
done < <(find "$SOUND_DIR" -maxdepth 1 -type f \( -iname "*.wav" -o -iname "*.mp3" \) -print0 2>/dev/null)

# Check if any audio files were found
if [ ${#WAV_FILES[@]} -eq 0 ]; then
    echo "Error: No WAV or MP3 files found in $SOUND_DIR" >&2
    exit 1
fi

# Select a random file
RANDOM_INDEX=$((RANDOM % ${#WAV_FILES[@]}))
SELECTED_FILE="${WAV_FILES[$RANDOM_INDEX]}"

# Detect platform and use appropriate audio player
if command -v afplay &> /dev/null; then
    # macOS
    afplay "$SELECTED_FILE" &
elif command -v aplay &> /dev/null; then
    # Linux with ALSA
    aplay -q "$SELECTED_FILE" &
elif command -v paplay &> /dev/null; then
    # Linux with PulseAudio
    paplay "$SELECTED_FILE" &
elif command -v mpg123 &> /dev/null; then
    # Cross-platform mpg123
    mpg123 -q "$SELECTED_FILE" &
else
    echo "Error: No audio player found. Install afplay (macOS), aplay, paplay, or mpg123" >&2
    exit 1
fi

exit 0
