require "json"
require_relative "channels/email"

class Notifier
  def notify(user, message)
    EmailChannel.new.deliver(user, JSON.generate(message))
  end
end
