class EmailChannel
  def deliver(user, body)
    puts "#{user}: #{body}"
  end
end
