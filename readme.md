## [**Rhythmanalysis**](https://github.com/math-eaton/rhythmanalysis)

“Rhythmanalysis” was envisioned as an end-to-end method to implement sensing, interpreting, and logging of environment data as a means of diaristic investigation of a single, hyper-specific spatial context. By situating a sensor in a single fixed position, I wanted to investigate the banal but locally meaningful events that, as a resident of that place, would otherwise wash over me as a series of unremarkable blips, evaporating from my working memory. In effect, I sought to register and log the tidal movements of a place by translating a stream of sound into discrete lexical taxonomies to graph them and see what patterns emerge over long periods of time.

![Project Image](https://urbandata.me/urbansensing/wp-content/uploads/2025/05/IMG_6897-1024x768.jpg)

I was originally inspired by one remarkable blip that appeared outside my window: a pitch-black Dodge Challenger that would noisily accelerate over the speed bump directly in front of my Brooklyn apartment at astonishingly regular intervals. Day in and day out within a few poetic minutes of midnight, this mysterious car would blast down my block loud as can be. Is anything else happening out there with such regularity that doesn’t register quite as obviously as a muscle car? This project was my attempt to find out.

This system attempts to listen to a space, classify events that unfold there using machine learning, and map those events’ recurrence across time in order to reveal the rhythmic pulsations of a highly specific place. The title, “Rhythmanalysis,” is borrowed from Henri Lefebvre’s writing on periodicity. Lefebvre asserts that reading phenomena by their situation in time is a useful tool for constructing a space by uncovering emergent patterns and variations on those patterns. Also a recent source of inspiration: the [**periodic motions of the cosmos**](https://math-eaton.github.io/orbital/) invisible to the human eye but intelligible through longitudinal observation.

Once my database grows, the resulting time series may eventually reveal periodicity in the sonic events that unfold outside my window. Graphing these classified events in a time series and exploring the linkages between common event nodes across variable lengths of time could expose a tidal sequence buried in the otherwise unintelligible noise of street life.

## **Site selection**

My original plan was to situate the field recorder in my bedroom, facing the rear window, in order to temper my concerns about public surveillance. Upon self-reflection, this was more motivated as a narcissistic endeavor to seethe about the construction taking place on either side of my brownstone. Instead, I chose a street-facing position in my apartment’s office space. This offered a more compelling and complete sampling site for logging activity on my block.

## **The sensor**

Over time, I have inherited bins of discrete electronics, both from my own hobbies and a cadre of incomplete projects, and from the generosity of a friend (shoutout Dr. Mehdi E.). Rather than purchase a new array of sensors for this class, I opted to cobble together what was already under my desk into a functioning system. Given the materials at my disposal and a sensor-based curriculum, a major time sink for this project involved my attempt to roll my own portable field recorder on the Teensy development board using an electret microphone, preamp, and the i2s protocol to pipe audio in the required format to a computer for ML inferencing. In the end, my Raspberry Pi 3b+ had enough compute power to process audio *and* the classification model in realtime, so I used my fallback factory-built USB microphone and pivoted to a workflow prioritizing the post-process of raw environmental data i.e. sounds.

## **The computer**

Onboard, a “flattened” instantiation of the pretrained [**YAMNet ML model**](https://www.kaggle.com/models/google/yamnet) performs inferences on audio input as it is ingested into the system. YAMNet was trained using the [**AudioSet**](https://research.google.com/audioset/) human-annotated audio database, and is able to infer the likelihood of a given audio event's category among 521 possible [**classes**](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv) ranging from the concrete ("doorbell") to the somewhat nebulous ("cacophony").

In my processing pipeline, sound is merely monitored, rather than recorded, and processed in-memory as an audio buffer. This alleviated my early concerns regarding the capture and storage of personally-identifying activity on the street and any attendant breach of ethics. Practically speaking, my Raspberry Pi OS is running solely on a 32GB micro-SD card, so storing recordings on board was a major storage consideration, even after compression. My USB microphone hardware is locked to a 44,100 samples/second sample rate, so conversion to 16,000 samples - the only state intelligible by the ML model - was crucial.

My first intuition was to record uncompressed wav files to storage in manageable 60-minute chunks, post-process from 44.1K to 16K, run the model, then discard the original and converted recordings. This would still result in [**~100+ MB**](https://www.colincrawley.com/audio-file-size-calculator/) files per processing loop. That would require not insignificant processing overhead every N minutes, plus an obligatory lead time to record then push outputs to the log. For what I was hoping to be a realtime audio classification scheme, this would have introduced unacceptable latency. Instead, I downsampled the 44.1K digital audio immediately post-ADC in order to pass the audio directly into the tensor array. The 16K audio parameter was likely devised as an efficient translation from 48,000 samples/second, which is a common high fidelity digital sample rate - sampling the audio input every three samples would have been a delight, but I had to use a slightly noisier divisor to reach my 16,000.

Since the model is pretrained and fairly immutable, expected input parameters for good performance are well documented. The model expects 0.975 seconds of audio input, which translates to exactly 15,600 samples of data. In order to make inferences on events that may be longer than 0.975 seconds, each successive inference is offset half a second from the previous. In this manner, each “window” of classification overlaps the previous, and I encoded a most-likely inference by averaging successive windows.

The text output records highest likelihood event inference, the model’s confidence in that classification, and the inferred audio frame’s amplitude in decibels, with timestamps, at a three-second resolution.

![Screenshot](https://urbandata.me/urbansensing/wp-content/uploads/2025/05/Screenshot-2025-05-12-at-4.56.42 PM-1-1024x360.png)

Logged events are encoded as CSV and saved to disk as a redundancy. Using the MQTT protocol, the same log is passed from the main classification process to a secondary publishing daemon, which in turn uploads each record to a Postgres SQL database hosted by the cloud service Render. Lastly, the database is parsed as an API endpoint by a D3 JavaScript visualization.

## **Conclusions**

Data collection in progress! I am not yet prepared to draw any conclusions from the output logs, beyond cursory diurnal patterns of wildlife and human activity. The text logs are compact, but my database and associated [**API**](https://rhythmanalysis.onrender.com/api/audio_logs) are growing steadily, and I would like to reinforce the pipeline for better reliability over long spans of time. I am already assembling a second Raspberry Pi device to host and serve the PostgreSQL database from home, rather than rely on a Render cloud service subscription.

Scaling up the system into an array at the urban scale would enable a useful construction of a continuous sonic fabric of a place, and how it is modulated over time. This could offer an anonymized* glimpse into its “temperature,” both in a first-order sonic sense, but also reflecting the uses, movements, sentiments, and other second-order, sound-emitting events that constitute a place.

*Assuming the taxonomies and monitored outputs resemble the ones YAMNet and I used … unprocessed, a network of microphones is arguably a more invasive mode of surveillance than cameras.*

Developing my project forcefully reminded me about squaring the circle of telos+techne. Following through with an idea is difficult but rewarding! Based on my everyday immersion (or, submersion) in technologies like YouTube's dynamically-generated subtitles, I naïvely assumed this audio-recognition concept would be pretty straightforward. No! To get these sounds on screen I had to figure out, to some degree: machine learning, TensorFlow, DSP and audio processing at the sample level, Linux, headless computation, *daemons*, SSH, port forwarding, PostgreSQL database management, API construction, on and on and on. This is what they mean by “full-stack”? I am ever in awe of these quotidian infrastructures.

Sonically, I was challenged to develop alternate habits of pattern recognition; to listen closer to the spaces in which I *already* find myself situated and attending to what I tend to actively perceive (sudden changes, short transient events) as well as more “legato,” subtle shifts in what’s happening outside of my working memory.

---


*Rhythmanalysis was developed as part of Anthony Vanky's Urban Sensing and Data Workshop: ["Embodying Urban Environments"](https://urbandata.me/urbansensing/) course at the Columbia University Graduate School of Architecture, Planning, and Preservation; and Seth Cluett's Sound: Advanced Topics II "Species of Spaces" course at the Columbia University Computer Music Center.*


***LLM disclaimer**: I am a competent-enough but self-taught and unsophisticated programmer with a firm grasp on the fundamentals of digital audio signal processing, an enthusiastic but very much in-progress training in sensors and IoT, middling understanding of good database management practices, and zero technical knowledge of machine learning techniques beyond critical readings. I made extensive use of ChatGPT-4 in-browser and with GitHub Copilot for rapid prototyping of the programs and end-to-end data processing pipelines that constitute this project.*