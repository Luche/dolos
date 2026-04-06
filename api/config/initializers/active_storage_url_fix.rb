# Active Storage's BaseController sets url_options from the raw request, which
# loses the script_name (relative_url_root) and uses the internal protocol/host
# when behind a reverse proxy. Override with the configured external API URL.
Rails.application.config.to_prepare do
  if Rails.env.production?
    ActiveStorage::BaseController.before_action do
      if Rails.configuration.respond_to?(:dolos_api_url)
        api_url = Rails.configuration.dolos_api_url
        ActiveStorage::Current.url_options = {
          protocol: api_url.scheme,
          host:     api_url.host,
          port:     api_url.port,
          script_name: api_url.path.presence
        }.compact
      end
    end
  end
end
