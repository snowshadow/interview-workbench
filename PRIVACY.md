# Privacy and data flow

Interview Workbench is local-first, but configured providers receive sensitive data:

- The ASR provider receives microphone audio while transcription is active.
- The LLM provider receives the selected transcript segment, interview preparation,
  role requirements, and prior question summaries when an analysis is requested.
- Resumes, transcripts, notes, and analysis results are stored on the local machine.

When the local MCP server is connected, an AI harness can read interview context,
paginated transcripts, and saved artifacts at the user's request, then write Markdown
artifacts back to the workbench. The MCP server uses stdio and does not open another
network port. Data sent to a model still follows the privacy settings of the selected
harness and model provider.

Users are responsible for obtaining any consent required to record or transcribe an
interview in their jurisdiction. The application does not silently record audio.

The project should be distributed without real candidate data. Use synthetic fixtures
in tests, screenshots, issues, and documentation.
