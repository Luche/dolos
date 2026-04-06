class ApplicationController < ActionController::API
  def default_url_options
    if Rails.configuration.respond_to?(:dolos_api_url)
      { protocol: Rails.configuration.dolos_api_url.scheme }
    else
      {}
    end
  end
end
