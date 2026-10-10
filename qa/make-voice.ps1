# Speaks a line with the Windows voice into a 16 kHz mono WAV (with a second of silence first), used
# as the fake microphone in browser tests.   powershell -File qa\make-voice.ps1 "text" out.wav
param([string]$Text, [string]$Out)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out, $fmt)
$s.Rate = 0
$p = New-Object System.Speech.Synthesis.PromptBuilder
$p.AppendBreak([TimeSpan]::FromMilliseconds(800))
$p.AppendText($Text)
$p.AppendBreak([TimeSpan]::FromMilliseconds(2500))
$s.Speak($p)
$s.Dispose()
