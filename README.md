# The Count

The Count is a system for collecting data related to events that happen on [The Exchange](https://github.com/PRX/exchange.prx.org). For example, page views, playback of audio, etc.

### action.js

This is deployed as an AWS Lambda function as an endpoint of an API Gateway. Requests are made to that endpoint to record events. For example:

`example.com/action.gif?event=view`

Events are recoded to a Kinesis data stream.

### writer.js

A second Lambda function is triggered by that Kinesis data stream. It reads event data in batches, and writes them out, one event per line, to text files in a file system intended to be processed by [The Castle](https://github.com/PRX/TheCastle).
