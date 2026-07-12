# Privacy and data flow

Interview Workbench is local-first, but configured providers receive sensitive data:

- The ASR provider receives microphone audio while transcription is active.
- The LLM provider receives the selected transcript segment, interview preparation,
  role requirements, and prior question summaries when an analysis is requested.
- Resumes, transcripts, notes, and analysis results are stored on the local machine.

Users are responsible for obtaining any consent required to record or transcribe an
interview in their jurisdiction. The application does not silently record audio.

The project should be distributed without real candidate data. Use synthetic fixtures
in tests, screenshots, issues, and documentation.
