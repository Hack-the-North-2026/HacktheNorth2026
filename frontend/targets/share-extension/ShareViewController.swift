import UIKit
import UniformTypeIdentifiers
import UserNotifications

final class ShareViewController: UIViewController {
  private let apiBaseURL = "__API_BASE_URL__"
  private let titleLabel = UILabel()
  private let detailLabel = UILabel()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let closeButton = UIButton(type: .system)

  override func viewDidLoad() {
    super.viewDidLoad()
    configureView()
    receiveImage()
  }

  private func configureView() {
    view.backgroundColor = UIColor(red: 0.02, green: 0.02, blue: 0.035, alpha: 1)
    titleLabel.text = "Finding this fit"
    titleLabel.textColor = .white
    titleLabel.font = .systemFont(ofSize: 22, weight: .bold)
    titleLabel.textAlignment = .center
    detailLabel.text = "Preparing your shared image…"
    detailLabel.textColor = UIColor(white: 0.65, alpha: 1)
    detailLabel.font = .systemFont(ofSize: 15)
    detailLabel.numberOfLines = 0
    detailLabel.textAlignment = .center
    spinner.color = UIColor(red: 0.61, green: 0.61, blue: 1, alpha: 1)
    spinner.startAnimating()
    closeButton.setTitle("Close", for: .normal)
    closeButton.tintColor = UIColor(red: 0.61, green: 0.61, blue: 1, alpha: 1)
    closeButton.isHidden = true
    closeButton.addTarget(self, action: #selector(closeExtension), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [spinner, titleLabel, detailLabel, closeButton])
    stack.axis = .vertical
    stack.spacing = 16
    stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  private func receiveImage() {
    guard !apiBaseURL.contains("replace-with-your-backend") else {
      showFailure("Set EXPO_PUBLIC_API_BASE_URL to your HTTPS backend before building.")
      return
    }
    guard
      let item = extensionContext?.inputItems.first as? NSExtensionItem,
      let provider = item.attachments?.first(where: {
        $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
      })
    else {
      showFailure("Share one image with Fit Stealer.")
      return
    }

    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] source, error in
      guard let self else { return }
      guard let source, error == nil else {
        self.showFailure("Fit Stealer couldn’t read this image.")
        return
      }
      let filename = source.lastPathComponent.isEmpty ? "shared-image.jpg" : source.lastPathComponent
      let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + filename)
      do {
        try FileManager.default.copyItem(at: source, to: copy)
        Task { await self.upload(imageURL: copy) }
      } catch {
        self.showFailure("Fit Stealer couldn’t prepare this image.")
      }
    }
  }

  private func upload(imageURL: URL) async {
    updateDetail("Uploading your fit…")
    do {
      defer { try? FileManager.default.removeItem(at: imageURL) }
      let imageData = try Data(contentsOf: imageURL)
      let boundary = "FitStealer-\(UUID().uuidString)"
      var request = URLRequest(url: URL(string: "\(apiBaseURL)/api/identify")!)
      request.httpMethod = "POST"
      request.timeoutInterval = 60
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
      request.httpBody = multipartBody(
        boundary: boundary,
        imageData: imageData,
        filename: imageURL.lastPathComponent
      )

      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        throw ShareError.message("The server rejected this image.")
      }
      let created = try JSONDecoder().decode(JobResponse.self, from: data)
      updateDetail("Searching for matching pieces…")
      try await waitUntilFinished(jobID: created.job_id)
      await notifyReady(jobID: created.job_id)
    } catch {
      showFailure(error.localizedDescription)
    }
  }

  private func waitUntilFinished(jobID: String) async throws {
    let deadline = Date().addingTimeInterval(90)
    while Date() < deadline {
      try await Task.sleep(for: .seconds(1))
      let url = URL(string: "\(apiBaseURL)/jobs/\(jobID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobID)")!
      var request = URLRequest(url: url)
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.timeoutInterval = 15
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { continue }
      let job = try JSONDecoder().decode(JobResponse.self, from: data)
      if job.status == "done" { return }
      if job.status == "error" {
        throw ShareError.message(job.error ?? "Fit Stealer couldn’t identify this image.")
      }
    }
    throw ShareError.message("Identification took too long. Try again.")
  }

  @MainActor
  private func notifyReady(jobID: String) async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
      showSuccess("Your results are ready. Open Fit Stealer to continue.")
      return
    }
    let content = UNMutableNotificationContent()
    content.title = "Your fit is ready"
    content.body = "Tap to see the clothing matches."
    content.sound = .default
    content.userInfo = ["url": "/job/\(jobID)"]
    let request = UNNotificationRequest(identifier: "fit-stealer-\(jobID)", content: content, trigger: nil)
    do {
      try await UNUserNotificationCenter.current().add(request)
      showSuccess("Results ready — tap the notification to view them.")
    } catch {
      showSuccess("Your results are ready. Open Fit Stealer to continue.")
    }
  }

  private func multipartBody(boundary: String, imageData: Data, filename: String) -> Data {
    var body = Data()
    func append(_ value: String) { body.append(Data(value.utf8)) }
    append("--\(boundary)\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\nimage\r\n")
    append("--\(boundary)\r\nContent-Disposition: form-data; name=\"origin\"\r\n\r\nios_share\r\n")
    append("--\(boundary)\r\nContent-Disposition: form-data; name=\"image\"; filename=\"\(filename)\"\r\n")
    append("Content-Type: image/jpeg\r\n\r\n")
    body.append(imageData)
    append("\r\n--\(boundary)--\r\n")
    return body
  }

  private func updateDetail(_ text: String) {
    DispatchQueue.main.async { self.detailLabel.text = text }
  }

  private func showSuccess(_ text: String) {
    DispatchQueue.main.async {
      self.spinner.stopAnimating()
      self.titleLabel.text = "Upload complete"
      self.detailLabel.text = text
      self.closeButton.isHidden = false
    }
  }

  private func showFailure(_ text: String) {
    DispatchQueue.main.async {
      self.spinner.stopAnimating()
      self.titleLabel.text = "Couldn’t identify"
      self.detailLabel.text = text
      self.closeButton.isHidden = false
    }
  }

  @objc private func closeExtension() {
    extensionContext?.completeRequest(returningItems: nil)
  }
}

private struct JobResponse: Decodable {
  let job_id: String
  let status: String
  let error: String?
}

private enum ShareError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self { case .message(let message): return message }
  }
}
