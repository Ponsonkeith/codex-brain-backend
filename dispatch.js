// dispatch.js

const dispatches = [];

const STATUS_FLOW = {
  "Pending": ["Scheduled", "Cancelled"],
  "Scheduled": ["Out for Delivery", "Cancelled"],
  "Out for Delivery": ["Delivered", "Cancelled"],
  "Delivered": [],
  "Cancelled": []
};

function createDispatch(id) {
  const dispatch = {
    id,
    status: "Pending",
    history: [
      { status: "Pending", time: new Date().toISOString() }
    ]
  };

  dispatches.push(dispatch);
  return dispatch;
}

function getDispatch(id) {
  return dispatches.find(d => d.id === id);
}

function updateStatus(id, newStatus) {
  const dispatch = getDispatch(id);

  if (!dispatch) {
    return { error: "Dispatch not found" };
  }

  const currentStatus = dispatch.status;
  const allowed = STATUS_FLOW[currentStatus];

  if (!allowed.includes(newStatus)) {
    return {
      error: `Invalid transition from ${currentStatus} to ${newStatus}`
    };
  }

  dispatch.status = newStatus;

  dispatch.history.push({
    status: newStatus,
    time: new Date().toISOString()
  });

  return dispatch;
}

function getAllDispatches() {
  return dispatches;
}

export default {
  createDispatch,
  updateStatus,
  getDispatch,
  getAllDispatches
};