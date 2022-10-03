const cors = require("cors");
const axios = require("axios");
const app = require("express")();
const _ = require("lodash");
const clientio = require("socket.io-client");
const getMAC = require("getmac").default;
const macAddress = process.env.MAC_ADDRESS || getMAC();
const { json, urlencoded } = require("body-parser");

require("dotenv").config();

app.use(cors());

// parse application/x-www-form-urlencoded
app.use(urlencoded({ extended: false }));

// parse application/json
app.use(json());

const http = require("http").Server(app);
const io = require("socket.io")(http, {
  cors: true,
  origins: ["*"],
});

const mqtt = require("mqtt");
const client = mqtt.connect(process.env.MQTT_URL);

var cloudSocketClient;
const deviceSubscription = {};

app.get("/", (req, res) => {
  res.json({ message: "Socket io - Client & Server" });
});

app.post("/slave_disconnect", (req, res) => {
  //SLAVE DISCONNECT>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // console.log("slave disconnected api >>> ", req);
  const dataToEmit = { macAddress: req?.body?.macAddress };
  io.emit("slave-disconnect", dataToEmit);

  if (cloudSocketClient) {
    cloudSocketClient.emit("slave-disconnect", dataToEmit);
  }
  res.json({ message: true });
  //SLAVE CONNECT>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
});

app.post("/slave_connect", (req, res) => {
  //SLAVE CONNECT>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // console.log("slave connected api >>> ", req);
  const dataToEmit = { macAddress: req?.body?.macAddress };
  io.emit("slave-connect", dataToEmit);

  if (cloudSocketClient) {
    cloudSocketClient.emit("slave-connect", dataToEmit);
  }
  res.json({ message: true });
  //SLAVE CONNECT>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
});

const handleMasterBoxUpdate = async (reqBody) => {
  try {
    await axios.patch(
      `${process.env.API_URL}/masterbox/${macAddress}`,
      reqBody
    );
    console.log("Update Successfull");
  } catch (error) {
    console.log("Error while patching", error.message);
  }
};

const listenToCloudSocketEvents = () => {
  // cloud socket start
  cloudSocketClient.on("connect_error", (error) => {
    console.log("Connection Error >> ", error);
  });

  cloudSocketClient.on("slave-disconnect", (data) => {
    console.log("Connection Error >> ", data);
  });

  cloudSocketClient.on("connect", () => {
    console.log("Connected to Socket Server");
    handleMasterBoxUpdate({
      eventType: "connected",
      time: new Date(),
    });
  });

  cloudSocketClient.on("error", (msg) => {
    console.log("Error from Cloud Socket Server > ", msg);
  });

  cloudSocketClient.on("disconnect", () => {
    // RECONNECT TO SOCKET, ON DISCONNECTION
    console.log(`Device ${macAddress} Disconnected`);
    handleMasterBoxUpdate({
      eventType: "disconnected",
      time: new Date(),
    });
    setTimeout(() => {
      console.log(`Trying to reconnect ${macAddress}`);
      cloudSocketClient.connect();
    }, 15000);
  });

  cloudSocketClient.on("api-request", async ({ userId, apiData, uuid }) => {
    try {
      console.log(`${process.env.API_URL}/${apiData.url}`);
      const response = await axios({
        ...apiData,
        url: `${process.env.API_URL}/${apiData.url}`,
      });

      console.log("emitting response");

      cloudSocketClient.emit("api-response", {
        response: _.get(response, "data"),
        userId,
        uuid,
      });
    } catch (error) {
      console.log("emitting error", error);

      const errorObj = _.get(error, "response.data", {
        message: "Internal Server Error",
        status: 500,
      });

      cloudSocketClient.emit("api-response", {
        error: errorObj,
        userId,
        uuid,
      });
    }
  });

  cloudSocketClient.on(
    "subscribeToDeviceData",
    ({ userId, trialId, deviceId, subjectId }) => {
      const keyToUse = `${trialId}_${deviceId}_${subjectId}`;
      deviceSubscription[keyToUse] = [
        ...new Set([...(deviceSubscription[keyToUse] || []), userId]),
      ];
      console.log(
        "subscribeToDeviceData - deviceSubscription >>> ",
        deviceSubscription
      );
    }
  );

  cloudSocketClient.on(
    "unsubscribeToDeviceData",
    ({ userId, trialId, deviceId, subjectId }) => {
      const keyToUse = `${trialId}_${deviceId}_${subjectId}`;
      _.remove(deviceSubscription[keyToUse], (e) => e === userId);
      console.log(
        "unsubscribeToDeviceData - deviceSubscription >>> ",
        deviceSubscription
      );
    }
  );

  cloudSocketClient.on("deviceStateUpdated", (data) => {
    console.log("deviceStateUpdated cloud >>> ", data);
    if (data.emitOnIO !== false) {
      io.emit("deviceStateUpdated", data);
    }
  });
};

const bootstrapSocketService = async () => {
  try {
    const {
      data: { data: masterBoxData },
    } = await axios.get(`${process.env.API_URL}/masterbox`);
    if (masterBoxData && masterBoxData[0] && masterBoxData[0].userEmail) {
      cloudSocketClient = clientio(
        `${process.env.CLOUD_SOCKET_URL}?deviceType=masterbox&macAddress=${macAddress}`,
        {
          auth: {
            token: process.env.MASTERBOX_SECRET_ACCESS_TOKEN,
            assignedToUser: _.get(masterBoxData?.[0], "userEmail", null),
          },
        }
      );
      listenToCloudSocketEvents();
      return;
    }
    console.log("No master boxes or not assigned to user");
  } catch (error) {
    console.log(
      "Error while bootstrapping, trying to bootstrap again in 1 min.",
      error
    );
  }
  setTimeout(() => {
    bootstrapSocketService();
  }, 60000);
};

bootstrapSocketService();

io.on("connection", (socket) => {
  console.log("a user connected");
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });

  socket.on("deviceStateUpdated", (data) => {
    console.log("deviceStateUpdated local >>> ", data);
    io.emit("deviceStateUpdated", data);
    cloudSocketClient?.emit("deviceStateUpdated", { ...data, emitOnIO: false });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`listening on *:${process.env.PORT || PORT}`);
});

client.on("connect", function () {
  console.log("mqtt connected");
  client.subscribe("devdata-socket", function (err, data) {
    if (!err) {
      console.log("subscribed to topic devdata-socket over mqtt successfully");
    }
  });

  client.subscribe("trialCompleted", function (err) {
    if (!err) {
      console.log("subscribed to topic trialCompleted over mqtt successfully");
    }
  });

  client.subscribe("fileTransfered", function (err) {
    if (!err) {
      console.log("subscribed to topic fileTransfered over mqtt successfully");
    }
  });
});

const deviceDataToSend = {};
const intervals = {};

client.on("message", function (topic, message) {
  // message is Buffer
  // console.log(message.toString());
  const data = JSON.parse(message.toString());

  switch (topic) {
    case "devdata-socket":
      let topic = `${data[0].trialId}_${data[0].deviceId}_${data[0].subjectId}`;
      if (data && data.length > 0) {
        io.emit(topic, data);

        if (deviceSubscription[topic]?.length) {
          (deviceSubscription[topic] || []).forEach((userId) => {
            cloudSocketClient.emit("deviceData", {
              userId,
              trialId: data[0].trialId,
              deviceId: data[0].deviceId,
              subjectId: data[0].subjectId,
              data,
            });
          });
        }
      }
      break;
    case "trialCompleted":
      let topicToEmit = `${data.trialId}_${data.deviceId}_${data.subjectId}`;
      clearInterval(intervals[topicToEmit]);
      delete intervals[topicToEmit];
      delete deviceDataToSend[topicToEmit];
      io.emit(`trialCompleted`, data);

      if (deviceSubscription[topicToEmit]?.length) {
        (deviceSubscription[topicToEmit] || []).forEach((userId) => {
          cloudSocketClient?.emit("trialCompleted", { userId, data });
        });
      }
      break;
    case "fileTransfered":
      console.log("fileTransfered >>> ", data);
      io.emit("fileTransfered", data);
      cloudSocketClient?.emit("fileTransfered", data);
      break;
  }
  // client.end();
});
