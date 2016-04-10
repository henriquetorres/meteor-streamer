/* globals EV */

class StreamerCentral {
	constructor() {
		this.instances = {};
	}
}

Meteor.StreamerCentral = new StreamerCentral;


Meteor.Streamer = class Streamer extends EV {
	constructor(name, {retransmission} = {retransmission: true}) {
		if (Meteor.StreamerCentral.instances[name]) {
			console.warn('Streamer instance already exists:', name);
			return Meteor.StreamerCentral.instances[name];
		}

		super();

		Meteor.StreamerCentral.instances[name] = this;

		this.name = name;
		this.retransmission = retransmission;

		this.subscriptions = [];
		this.subscriptionsByEventName = {};
		this.transformers = {};

		this.iniPublication();
		this.initMethod();

		this._allowRead = function() {
			return true;
		};

		this._allowWrite = function() {
			return true;
		};
	}

	get subscriptionName() {
		return `stream-${this.name}`;
	}

	allowRead(fn) {
		if (typeof fn === 'function') {
			this._allowRead = fn;
		}
	}

	allowWrite(fn) {
		if (typeof fn === 'function') {
			this._allowWrite = fn;
		}
	}

	addSubscription(subscription, eventName) {
		this.subscriptions.push(subscription);

		if (!this.subscriptionsByEventName[eventName]) {
			this.subscriptionsByEventName[eventName] = [];
		}

		this.subscriptionsByEventName[eventName].push(subscription);
	}

	removeSubscription(subscription, eventName) {
		const index = this.subscriptions.indexOf(subscription);
		if (index > -1) {
			this.subscriptions.splice(index, 1);
		}

		if (this.subscriptionsByEventName[eventName]) {
			const index = this.subscriptionsByEventName[eventName].indexOf(subscription);
			if (index > -1) {
				this.subscriptionsByEventName[eventName].splice(index, 1);
			}
		}
	}

	transform(eventName, fn) {
		if (typeof eventName === 'function') {
			fn = eventName;
			eventName = '__all__';
		}

		if (!this.transformers[eventName]) {
			this.transformers[eventName] = [];
		}

		this.transformers[eventName].push(fn);
	}

	applyTransformers(methodScope, eventName, args) {
		if (this.transformers['__all__']) {
			this.transformers['__all__'].forEach((transform) => {
				args = transform.call(methodScope, eventName, args);
				methodScope.tranformed = true;
				if (!Array.isArray(args)) {
					args = [args];
				}
			});
		}

		if (this.transformers[eventName]) {
			this.transformers[eventName].forEach((transform) => {
				args = transform.call(methodScope, ...args);
				methodScope.tranformed = true;
				if (!Array.isArray(args)) {
					args = [args];
				}
			});
		}

		return args;
	}

	iniPublication() {
		const stream = this;
		Meteor.publish(this.subscriptionName, function(eventName, useCollection) {
			if (stream._allowRead.call(this, eventName) !== true) {
				this.stop();
				return;
			}

			const subscription = {
				subscription: this,
				eventName: eventName
			};

			stream.addSubscription(subscription, eventName);

			this.onStop(() => {
				stream.removeSubscription(subscription, eventName);
			});

			if (useCollection === true) {
				// Collection compatibility
				this._session.sendAdded(stream.subscriptionName, 'id', {
					eventName: eventName
				});
			}

			this.ready();
		});
	}

	initMethod() {
		const stream = this;
		const method = {};

		method[this.subscriptionName] = function(eventName, ...args) {
			this.unblock();

			if (stream._allowWrite.call(this, eventName, ...args) !== true) {
				return;
			}

			const methodScope = {
				userId: this.userId,
				connection: this.connection,
				originalParams: args,
				tranformed: false
			};

			args = stream.applyTransformers(methodScope, eventName, args);

			super.emitWithScope(eventName, methodScope, ...args);

			if (stream.retransmission === true) {
				stream.emit(eventName, ...args);
			}
		};

		try {
			Meteor.methods(method);
		} catch (e) {
			console.error(e);
		}
	}

	emit(eventName, ...args) {
		const subscriptions = this.subscriptionsByEventName[eventName];
		if (!Array.isArray(subscriptions)) {
			return;
		}

		subscriptions.forEach((subscription) => {
			subscription.subscription._session.sendChanged(this.subscriptionName, 'id', {
				eventName: eventName,
				args: args
			});
		});
	}
};