document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('awsConfigForm');
  const status = document.getElementById('status');
  
  // Load existing config
  const { awsConfig } = await chrome.storage.local.get('awsConfig');
  if (awsConfig) {
    document.getElementById('accessKeyId').value = awsConfig.accessKeyId;
    document.getElementById('secretAccessKey').value = awsConfig.secretAccessKey;
    document.getElementById('region').value = awsConfig.region;
    document.getElementById('bucketName').value = awsConfig.bucketName;
  }
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const config = {
      accessKeyId: document.getElementById('accessKeyId').value,
      secretAccessKey: document.getElementById('secretAccessKey').value,
      region: document.getElementById('region').value,
      bucketName: document.getElementById('bucketName').value
    };
    
    try {
      await chrome.storage.local.set({ awsConfig: config });
      
      status.textContent = 'Configuration saved successfully!';
      status.className = 'status success';
      status.style.display = 'block';
      
      // Notify background script to reinitialize AWS
      chrome.runtime.sendMessage({ cmd: 'reinitAWS' });
      
      setTimeout(() => {
        status.style.display = 'none';
      }, 3000);
    } catch (error) {
      status.textContent = 'Error saving configuration: ' + error.message;
      status.className = 'status error';
      status.style.display = 'block';
    }
  });
}); 