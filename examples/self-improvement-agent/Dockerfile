FROM alpine:3.20

RUN apk add --no-cache curl bash

WORKDIR /example
COPY agent.json README.md run.sh ./
RUN chmod +x run.sh

ENTRYPOINT ["./run.sh"]
